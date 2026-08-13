export interface ScannerHeartbeat {
  state: string;
  lastSeenAt: string;
}

export const SCANNER_LEASE_STALE_MS = 45_000;

export function shouldRecoverInterruptedJobs(
  heartbeat: ScannerHeartbeat | null,
  nowMs = Date.now(),
  staleAfterMs = SCANNER_LEASE_STALE_MS,
): boolean {
  if (!heartbeat || heartbeat.state === "stopped") return true;
  const lastSeenMs = Date.parse(heartbeat.lastSeenAt);
  return !Number.isFinite(lastSeenMs) || nowMs - lastSeenMs > staleAfterMs;
}
