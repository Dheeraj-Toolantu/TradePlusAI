import { beforeEach, describe, expect, it } from "vitest";
import { baselineSnapshot, clearSnapshots, recordSnapshot, snapshotHistorySeconds } from "../../apps/web/lib/oi-snapshot-store";

const snap = (takenAt: number, spot: number) => ({ takenAt, spot, expiry: "2026-09-30", rows: [{ strike: 25000, ce: { ltp: 100, oi: 1000, volume: 10, iv: 12, delta: 0.5, trading_symbol: "X" } }] });

describe("OI snapshot store", () => {
  beforeEach(() => clearSnapshots());

  it("returns no baseline until a snapshot is at least 4 minutes old", () => {
    const now = 1_000_000_000;
    recordSnapshot("NIFTY", snap(now - 60_000, 25000));
    expect(baselineSnapshot("NIFTY", "2026-09-30", now)).toBeNull();
    expect(snapshotHistorySeconds("NIFTY", "2026-09-30", now)).toBe(60);
  });

  it("picks the snapshot closest to 5 minutes old and ignores stale ones", () => {
    const now = 1_000_000_000;
    recordSnapshot("NIFTY", snap(now - 20 * 60_000, 24900));
    recordSnapshot("NIFTY", snap(now - 6 * 60_000, 24950));
    recordSnapshot("NIFTY", snap(now - 5 * 60_000 + 10_000, 24960));
    recordSnapshot("NIFTY", snap(now - 60_000, 25000));
    expect(baselineSnapshot("NIFTY", "2026-09-30", now)?.spot).toBe(24960);
    expect(baselineSnapshot("BANKNIFTY", "2026-09-30", now)).toBeNull();
  });

  it("collapses snapshots taken less than 20 seconds apart", () => {
    const now = 1_000_000_000;
    recordSnapshot("NIFTY", snap(now - 5 * 60_000, 1));
    recordSnapshot("NIFTY", snap(now - 5 * 60_000 + 5_000, 2));
    expect(baselineSnapshot("NIFTY", "2026-09-30", now)?.spot).toBe(2);
  });
});
