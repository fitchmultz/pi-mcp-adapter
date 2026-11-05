# Conformance referee details

`prepare-referee.sh` builds the official `@modelcontextprotocol/conformance` 0.1.16 release source at commit `21a9a2febd7100d7c17ac1021ee7f2ed9f66a1e0`. It uses that source's committed npm lockfile and native build command. This release has four core and 22 OAuth client scenarios, with no 2026-07-28 client profile, so the driver selects the legacy profile.

`idp-discovery.patch` backports [upstream PR #574](https://github.com/modelcontextprotocol/conformance/pull/574). The cross-app IdP fixture supplies `response_types_supported`, `subject_types_supported`, and `id_token_signing_alg_values_supported`. Its pre-issued ID token uses RS256, the mandatory advertised algorithm in [OIDC Discovery §3](https://openid.net/specs/openid-connect-discovery-1_0.html#ProviderMetadata). ID-JAG signing remains ES256. No client assertions, result classification, scenario selection, or adapter OAuth validation changes.

A real SDK discovery call against the uncorrected fixture rejects the three missing fields before either exchange. The upstream regression demonstrates that failure and checks the corrected live fixture. All 26 client scenarios pass against the adapter with the source-built correction. There is no expected-failure baseline.

The source and generated referee bundle live only in a temporary directory, removed by the runner's exit trap. Every invocation applies the patch and builds from the recorded inputs, so no cached generated output can become stale. Git applies and validates the unified diff; Bash parses the two shell scripts. These unsupported Oxfmt formats do not add a maintained JavaScript/TypeScript coverage exemption. Replace the backport with the published upstream correction when available.
