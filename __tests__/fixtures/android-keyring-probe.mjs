import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';

// This process simulates Android. No hardware, real native code, browser or network.
const blocked = () => { throw new Error('External access forbidden in Android diagnostic probe'); };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = blocked;
http.request = http.get = https.request = https.get = blocked;
net.connect = net.createConnection = tls.connect = dgram.createSocket = blocked;
net.Server.prototype.listen = blocked;
globalThis.fetch = process.dlopen = blocked;
syncBuiltinESMExports();
Object.defineProperty(process, 'platform', { value: 'android', configurable: true });
Object.defineProperty(process, 'arch', { value: 'arm64' });
const mode = process.argv[2];
const home = process.cwd();
const receipt = { mode, platform: process.platform, arch: process.arch, execPath: process.execPath, version: process.version };
const auth = await import(pathToFileURL(join(home, 'mcp-auth.ts')).href);
const url = 'https://unreachable.invalid/mcp';
const server = 'android-diagnostic';
const entry = { tokens: { accessToken: 'synthetic-only' }, serverUrl: url };
const operations = [
  ['read', () => auth.getAuthForUrl(server, url)],
  ['write', () => auth.saveAuthEntry(server, entry, url)],
  ['remove', () => auth.removeAuthEntry(server)],
];
const legacy = auth.getAuthEntryFilePath(server);
const genericStatus = 'OAuth credential store unavailable. Configure or unlock the OS credential store and retry.';
const androidMessage = /Android\/Termux.*@napi-rs\/keyring.*native binding.*supported platform/i;

function checkFailures(nativeFailure) {
  const errors = operations.map(([operation, run]) => {
    let error;
    try { run(); } catch (caught) { error = caught; }
    return { operation, error };
  });
  const status = auth.inspectAuthForUrl(server, url);
  const messages = errors.map(({ operation, error }) => ({ operation, message: error?.message }));
  for (const { operation, error } of errors) {
    assert(error instanceof auth.OAuthCredentialStoreError);
    assert.equal(error.name, 'OAuthCredentialStoreError');
    assert.equal(error.code, 'OAUTH_CREDENTIAL_STORE_UNAVAILABLE');
    assert.equal(error.operation, operation);
    if (nativeFailure) {
      assert.equal(error.cause, nativeFailure);
      assert.equal(error.message, `Failed to ${operation} OAuth credentials for ${server} ${operation === 'write' ? 'to' : 'from'} the OS secure credential store`);
    } else {
      assert.match(error.message, androidMessage, JSON.stringify({ messages, status }));
      assert.match(error.cause.cause.message, /Failed to load @napi-rs\/keyring/);
      assert.match(error.cause.cause.cause.message, /Cannot find native binding/);
      assert(error.cause.cause.cause.cause.some(cause => mode === 'missing'
        ? cause.code === 'MODULE_NOT_FOUND' && cause.message.includes('@napi-rs/keyring-android-arm64')
        : cause.message === 'synthetic binding cannot load'));
    }
  }
  assert.equal(status.status, 'unavailable');
  if (nativeFailure) assert.equal(status.message, genericStatus);
  else assert.match(status.message, androidMessage);
  return { errors: messages, status };
}

if (mode === 'working') {
  assert.equal(auth.getAuthEntry(server), undefined);
  auth.saveAuthEntry(server, entry, url);
  assert.deepEqual(auth.getAuthForUrl(server, url), entry);
  assert.deepEqual(auth.inspectAuthForUrl(server, url), { status: 'present', entry });
  auth.removeAuthEntry(server);
  assert.deepEqual(auth.inspectAuthForUrl(server, url), { status: 'absent' });
  assert.equal(fs.existsSync(dirname(legacy)), false);
  const require = createRequire(join(home, 'package.json'));
  const binding = require('@napi-rs/keyring-android-arm64');
  binding.failure = new Error('Synthetic credential store locked');
  receipt.androidRuntimeFailure = checkFailures(binding.failure);
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  receipt.nonAndroidRuntimeFailure = checkFailures(binding.failure);
} else {
  receipt.emptyStore = checkFailures();
  assert.equal(fs.existsSync(dirname(legacy)), false);
  // A sentinel proves unavailable storage neither imports nor deletes legacy data.
  fs.mkdirSync(dirname(legacy), { recursive: true });
  const sentinel = 'not credentials; must never be read, imported, replaced or removed';
  fs.writeFileSync(legacy, sentinel);
  const read = fs.readFileSync;
  fs.readFileSync = (path, ...args) => {
    assert.notEqual(String(path), legacy, 'unavailable store must not read legacy credentials');
    return read(path, ...args);
  };
  syncBuiltinESMExports();
  receipt.unavailable = checkFailures();
  assert.equal(read(legacy, 'utf8'), sentinel);
  assert.deepEqual(fs.readdirSync(dirname(legacy)), ['tokens.json']);
  assert.deepEqual(fs.readdirSync(auth.getAuthBaseDir()), [legacy.split('/').at(-2)]);
}
receipt.passed = true;
console.log(JSON.stringify(receipt));
