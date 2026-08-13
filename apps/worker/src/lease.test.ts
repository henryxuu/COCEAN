import { describe, expect, it } from "vitest";
import { shouldRecoverInterruptedJobs } from "./lease.js";

describe("scanner worker lease", () => {
  const now = Date.parse("2026-08-12T00:01:00.000Z");

  it("recovers when no active heartbeat exists or the old worker stopped", () => {
    expect(shouldRecoverInterruptedJobs(null, now)).toBe(true);
    expect(
      shouldRecoverInterruptedJobs(
        { state: "stopped", lastSeenAt: "2026-08-12T00:00:59.000Z" },
        now,
      ),
    ).toBe(true);
  });

  it("does not steal a fresh lease but recovers a stale one", () => {
    expect(
      shouldRecoverInterruptedJobs(
        { state: "ready", lastSeenAt: "2026-08-12T00:00:50.000Z" },
        now,
      ),
    ).toBe(false);
    expect(
      shouldRecoverInterruptedJobs(
        { state: "ready", lastSeenAt: "2026-08-11T23:59:00.000Z" },
        now,
      ),
    ).toBe(true);
  });
});
