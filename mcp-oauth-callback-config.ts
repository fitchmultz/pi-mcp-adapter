/** SDK-free process-shared OAuth callback endpoint configuration. */

// Callback server configuration
export const DEFAULT_OAUTH_CALLBACK_PORT = 19876
export const DEFAULT_OAUTH_CALLBACK_PATH = "/callback"

let configuredOAuthCallbackPort = DEFAULT_OAUTH_CALLBACK_PORT

if (process.env.MCP_OAUTH_CALLBACK_PORT) {
  const parsedPort = Number.parseInt(process.env.MCP_OAUTH_CALLBACK_PORT, 10)
  if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
    configuredOAuthCallbackPort = parsedPort
  }
}

let oauthCallbackPort = configuredOAuthCallbackPort
let oauthCallbackPath = DEFAULT_OAUTH_CALLBACK_PATH

export function getConfiguredOAuthCallbackPort(): number {
  return configuredOAuthCallbackPort
}

export function getOAuthCallbackPort(): number {
  return oauthCallbackPort
}

export function setOAuthCallbackPort(port: number): void {
  oauthCallbackPort = port
}

export function getOAuthCallbackPath(): string {
  return oauthCallbackPath
}

export function setOAuthCallbackPath(path: string): void {
  oauthCallbackPath = path.startsWith("/") ? path : `/${path}`
}
