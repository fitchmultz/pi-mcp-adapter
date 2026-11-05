#!/usr/bin/env bash
set -euo pipefail

# Published conformance 0.1.16 source; the fixture correction changes no checks.
REVISION=21a9a2febd7100d7c17ac1021ee7f2ed9f66a1e0
PATCH="$(cd "$(dirname "$0")" && pwd)/idp-discovery.patch"
DESTINATION="$1"

curl --fail --silent --show-error --location \
  "https://github.com/modelcontextprotocol/conformance/archive/$REVISION.tar.gz" |
  tar -xz --strip-components=1 -C "$DESTINATION"
git -C "$DESTINATION" apply "$PATCH"
cd "$DESTINATION"
npm ci --ignore-scripts --no-audit --no-fund
npm run build
