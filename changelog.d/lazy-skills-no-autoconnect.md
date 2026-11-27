### Fixed

- Kept `lazy` and `lazy-keep-alive` MCP servers disconnected at startup and during live config reconciliation even when verified skills were previously cached; `eager` and `keep-alive` servers continue to verify and expose skills at startup, while lazy servers discover and expose skills once connected on demand.
