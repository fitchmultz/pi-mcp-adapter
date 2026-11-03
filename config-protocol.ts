import type { ServerEntry, OAuthConfig } from "./config-types.ts";
import { isConfigObject } from "./config-validation.ts";

/** Protocol options also enter from untyped file and JavaScript callers. */
export function validateUnknownServerProtocolConfig(definition: unknown): void {
  if (typeof definition !== "object" || definition === null) {
    return;
  }
  if ("protocolVersion" in definition) {
    validateProtocolVersion(definition.protocolVersion);
  }
  if (
    "retryOnTransportFailure" in definition &&
    definition.retryOnTransportFailure !== undefined &&
    typeof definition.retryOnTransportFailure !== "boolean"
  ) {
    throw new Error("retryOnTransportFailure must be a boolean");
  }
  if ("oauth" in definition) {
    validateIssuerOption(definition.oauth);
  }
}

function validateIssuerOption(oauth: unknown): void {
  if (
    isConfigObject(oauth) &&
    oauth.skipIssuerMetadataValidation !== undefined &&
    typeof oauth.skipIssuerMetadataValidation !== "boolean"
  ) {
    throw new Error("oauth.skipIssuerMetadataValidation must be a boolean");
  }
}

export function isNonInteractiveOAuth(config: OAuthConfig | false | null | undefined): boolean {
  return (
    config !== false &&
    config !== null &&
    config !== undefined &&
    (config.grantType === "client_credentials" || config.crossAppAccess !== undefined)
  );
}

/** Validate protocol options for both file and in-memory configurations. */
export function validateServerProtocolConfig(definition: ServerEntry): void {
  validateUnknownServerProtocolConfig(definition);
}

/** Only the literal boolean `true` disables a server. */
export function isServerDisabled(definition: ServerEntry | undefined): boolean {
  return definition?.disabled === true;
}

function validateProtocolVersion(value: unknown): void {
  if (value !== undefined && value !== "auto" && value !== "legacy") {
    throw new Error("protocolVersion must be auto or legacy");
  }
}
