import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import type { ManagedClient } from "./connection-runtime.ts";
import type { McpOAuthProvider } from "./mcp-oauth-provider.ts";

/** Keep the SDK's actual provider calls owned, including legacy GET bootstrap. */
export function ownOAuthProvider(
  client: ManagedClient,
  provider: McpOAuthProvider,
): OAuthClientProvider {
  const own = <T>(run: () => T | Promise<T>): Promise<T> =>
    client.ownNative(async () => {
      provider.lifetimeSignal.throwIfAborted();
      return run();
    });
  return {
    get redirectUrl() {
      return provider.redirectUrl;
    },
    get clientMetadata() {
      return provider.clientMetadata;
    },
    ...(provider.clientMetadataUrl !== undefined
      ? { clientMetadataUrl: provider.clientMetadataUrl }
      : {}),
    clientInformation: (...args) => own(() => provider.clientInformation(...args)),
    saveClientInformation: (...args) => own(() => provider.saveClientInformation(...args)),
    tokens: (...args) => own(() => provider.tokens(...args)),
    saveTokens: (...args) => own(() => provider.saveTokens(...args)),
    redirectToAuthorization: (...args) => own(() => provider.redirectToAuthorization(...args)),
    saveCodeVerifier: (...args) => own(() => provider.saveCodeVerifier(...args)),
    codeVerifier: () => own(() => provider.codeVerifier()),
    saveDiscoveryState: (...args) => own(() => provider.saveDiscoveryState(...args)),
    discoveryState: () => own(() => provider.discoveryState()),
    // oxlint-disable-next-line typescript/no-deprecated -- QX-024: SDK auth still forwards the issuer for cross-app authorization.
    saveAuthorizationServerUrl: (...args) =>
      own(() => provider.saveAuthorizationServerUrl(...args)),
    saveResourceUrl: (...args) => own(() => provider.saveResourceUrl(...args)),
    state: () => own(() => provider.state()),
    invalidateCredentials: (...args) => own(() => provider.invalidateCredentials(...args)),
    addClientAuthentication: (...args) => own(() => provider.addClientAuthentication(...args)),
    prepareTokenRequest: (...args) => own(() => provider.prepareTokenRequest(...args)),
  };
}
