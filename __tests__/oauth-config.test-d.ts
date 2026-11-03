import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { extractOAuthConfig } from "../mcp-auth-flow.ts";
import { McpOAuthProvider } from "../mcp-oauth-provider.ts";
import sharedDocument from "../docs/client-metadata.json" with { type: "json" };

it("rejects bad CAA shapes and contradictory grants without disclosing or resolving inputs", () => {
  const valid = { idpUrl: "https://idp.example", clientId: "idp", idToken: "TOKEN_SENTINEL" };
  const configs: unknown[] = [
    null,
    false,
    [],
    {},
    { ...valid, idToken: "" },
    { ...valid, idpUrl: 42 },
    { ...valid, clientId: [] },
    { ...valid, clientSecret: null },
    { ...valid, audience: "override" },
    { ...valid, resource: "override" },
  ].map((crossAppAccess) => ({ crossAppAccess }));
  configs.push(
    { crossAppAccess: valid, grantType: "authorization_code" },
    { crossAppAccess: valid, grantType: "client_credentials" },
  );
  for (const config of configs) {
    for (const build of [
      () => {
        // @ts-expect-error Untrusted OAuth values are rejected by the typed extraction API.
        return extractOAuthConfig({ oauth: config });
      },
      () =>
        new McpOAuthProvider(
          "bad",
          "https://resource.example",
          // @ts-expect-error Untrusted OAuth values are rejected by the typed provider API.
          config,
          {
            onRedirect() {
              throw new Error("Invalid configuration must not redirect");
            },
          },
        ),
    ]) {
      let error: unknown;
      try {
        build();
      } catch (caught) {
        error = caught;
      }
      assert(error instanceof Error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("crossAppAccess");
      expect(String(error)).not.toContain("TOKEN_SENTINEL");
      expect(error.cause).toBeUndefined();
    }
  }
});

it("validates private-key configuration and identity conflicts at both public boundaries without disclosure", () => {
  const valid = { privateKey: "PRIVATE_KEY_SENTINEL", algorithm: "ES256" };
  const invalid: unknown[] = [
    null,
    false,
    [],
    "PRIVATE_KEY_SENTINEL",
    {},
    { ...valid, privateKey: null },
    { ...valid, privateKey: [] },
    { ...valid, privateKey: "" },
    { ...valid, algorithm: "HS256" },
    { ...valid, algorithm: "none" },
    { ...valid, algorithm: 42 },
    { ...valid, algorithm: "" },
    { ...valid, audience: "" },
    { ...valid, audience: [] },
    { ...valid, lifetimeSeconds: 0 },
    { ...valid, lifetimeSeconds: 1.5 },
    { ...valid, lifetimeSeconds: Infinity },
    { ...valid, claims: [] },
    { ...valid, claims: null },
  ];
  const configs: unknown[] = invalid.map((privateKeyJwt) => ({ clientId: "id", privateKeyJwt }));
  configs.push(
    { privateKeyJwt: valid },
    { clientId: "id", clientSecret: "SECRET_SENTINEL", privateKeyJwt: valid },
    { clientMetadataUrl: sharedDocument.client_id, privateKeyJwt: valid },
  );
  for (const config of configs) {
    for (const build of [
      () => {
        // @ts-expect-error Untrusted OAuth values are rejected by the typed extraction API.
        return extractOAuthConfig({ oauth: config });
      },
      () =>
        new McpOAuthProvider(
          "validation",
          "https://server.example/mcp",
          // @ts-expect-error Untrusted OAuth values are rejected by the typed provider API.
          config,
          {
            onRedirect() {
              throw new Error("Invalid configuration must not redirect");
            },
          },
        ),
    ]) {
      let error: unknown;
      try {
        build();
      } catch (caught) {
        error = caught;
      }
      assert(error instanceof Error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("privateKeyJwt");
      expect(String(error)).not.toContain("SENTINEL");
      expect(error.cause).toBeUndefined();
    }
  }
});
