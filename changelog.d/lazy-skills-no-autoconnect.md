### Fixed

- Kept `lazy` and `lazy-keep-alive` MCP servers disconnected at startup and during live config reconciliation on fresh sessions even when verified skills were previously cached, while preserving verified skills discovered on demand across `/reload` without reconnecting the lazy server (`eager` and `keep-alive` servers continue to verify and expose skills at startup).
