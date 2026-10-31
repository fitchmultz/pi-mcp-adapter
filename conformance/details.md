# Conformance referee details

The referee selected in `conformance/run.sh` is `@modelcontextprotocol/conformance` 0.1.16. It has no 2026-07-28 client profile, so the driver uses the legacy profile. Its client suite has four core scenarios and 22 OAuth scenarios.

The referee's `auth/cross-app-access-complete-flow` IdP OIDC document omits `response_types_supported`, `subject_types_supported`, and `id_token_signing_alg_values_supported`. Native strict discovery rejects it before token exchange; `baseline-client.yml` records this known failure. Local HTTP tests cover valid cross-app flows separately.
