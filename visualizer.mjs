import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const agentDir = await mkdtemp(join(tmpdir(), 'pea217-agent-'));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.MCP_UI_VIEWER = 'none';
const piPackage = process.env.PEA_PI_PACKAGE ?? join(root, 'node_modules/@earendil-works/pi-coding-agent');
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime, VERSION } = await import(pathToFileURL(join(piPackage, 'dist/index.js')));
const { createAssistantMessageEventStream } = await import(pathToFileURL(resolve('node_modules/@earendil-works/pi-ai/dist/index.js')));
const {createMcpAdapter} = await import(pathToFileURL(resolve(process.env.PEA_ADAPTER_DIST ?? 'dist/index.js')));
const starts = [];
const inference = [];
const settingsManager = SettingsManager.inMemory();
const modelRuntime = await ModelRuntime.create({ agentDir });
const model = modelRuntime.getModel('openai', 'gpt-4o-mini');
assert(model);
await modelRuntime.setRuntimeApiKey(model.provider, 'offline-dogfood');
const sessionManager = SessionManager.create(agentDir, agentDir);
const resourceLoader = new DefaultResourceLoader({ cwd:agentDir, agentDir, settingsManager, noExtensions:true, noContextFiles:true, noSkills:true, noPromptTemplates:true, noThemes:true, extensionFactories:[
  createMcpAdapter({outputDirectory:agentDir, config:{mcpServers:{visualizer:{command:process.execPath, args:[resolve('examples/interactive-visualizer/dist/server.js')]}}}}),
  (api) => {api.on('before_agent_start', event => { starts.push(event.messageType); });},
] });
await resourceLoader.reload();
const { session } = await createAgentSession({ cwd:agentDir, agentDir, modelRuntime, model, settingsManager, resourceLoader, sessionManager, noTools:'builtin' });
await session.bindExtensions({});
session.agent.streamFunction = (selected, context) => {
  inference.push(context.messages.map(m=>typeof m.content==='string'?m.content:m.content.map(c=>c.type==='text'?c.text:'').join('\n')).join('\n'));
  const stream = createAssistantMessageEventStream();
  const last = context.messages.at(-1);
  const text = last?.content?.[0]?.text;
  const launch = text === 'Launch the public visualizer';
  const history = text === 'Read the app history';
  const call = launch ? {action:'call', server:'visualizer', tool:'show_chart', args:{type:'bar',title:'Public chart',labels:'Day 1,Day 2',datasets:'[{"label":"Demo","data":[2,4]}]'}} : history ? {action:'ui-messages'} : undefined;
  const content = call ? [{type:'toolCall',id:'dogfood-'+starts.length,name:'mcp',arguments:call}] : [{type:'text',text:'Offline response'}];
  const message = { role:'assistant', content, api:selected.api, provider:selected.provider, model:selected.id, usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}, stopReason:call?'toolUse':'stop', timestamp:Date.now() };
  queueMicrotask(() => {stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});});
  return stream;
};
const context = session.extensionRunner.createContext();
await session.prompt('Launch the public visualizer');
const latestResult = () => sessionManager.getBranch().findLast(x=>x.type==='message'&&x.message.role==='toolResult')?.message;
const outcome = latestResult();
const view = outcome?.details?.uiUrl;
assert(view, JSON.stringify(outcome ?? sessionManager.getBranch()));
starts.length=0;
inference.length=0;
const control = createServer(async (req,res)=>{
  try {
    if(req.url==='/export') {
      await session.waitForIdle();
      const output = await session.exportToHtml(join(agentDir, 'export.html'));
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(await readFile(output)); return;
    }
    if(req.method==='POST' && req.url==='/user') await session.prompt('Human follow-up');
    if(req.method==='POST' && req.url==='/history') {
      await session.prompt('Read the app history');
      res.end(JSON.stringify(latestResult())); return;
    }
    await session.waitForIdle();
    const messages = sessionManager.getBranch().filter(x=>x.type==='custom_message'||x.type==='message').map(x=>x.type==='custom_message'?{role:'custom',customType:x.customType,content:x.content}:{role:x.message.role,content:x.message.content});
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({starts,inference,messages}));
  } catch(error) { res.statusCode=500;res.end(String(error)); }
}).listen(0,'127.0.0.1');
await new Promise(resolve=>control.once('listening',resolve));
console.log(JSON.stringify({version:VERSION,mode:context.mode,hasUI:context.hasUI,view,control:`http://127.0.0.1:${control.address().port}`}));
process.once('SIGTERM', async ()=>{
  control.close();
  await session.extensionRunner.emit({type:'session_shutdown'});
  session.dispose();
  await rm(agentDir,{recursive:true,force:true});
  process.exit(0);
});
