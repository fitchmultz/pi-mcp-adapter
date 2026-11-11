/** Shared browser/server liveness contract; successful heartbeats renew the grace period. */
export const UI_HEARTBEAT_INTERVAL_MS = 10_000;
export const UI_ABANDONED_GRACE_MS = 60_000;
export const UI_WATCHDOG_INTERVAL_MS = 5_000;
