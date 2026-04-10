/**
 * ui-state.test.ts — UI Logic Tests
 *
 * Tests pure UI logic that doesn't require React rendering:
 * - getTimeAgo formatting
 * - Session tx merge + dedup logic
 * - Explorer URL construction
 * - Velocity monitor logic
 */

import { describe, it, expect } from "vitest";

// ── Re-implement getTimeAgo from App.tsx ──

function getTimeAgo(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(isoTimestamp).toLocaleDateString();
}

// ── Explorer URL builder ──

const explorerBase = "https://solomentelabs.com/explorer.html";

function buildTxUrl(txHash: string): string {
  return `${explorerBase}?tx=${txHash}`;
}

function buildAddressUrl(address: string): string {
  return `${explorerBase}?address=${address}`;
}

// ── Session tx merge logic (mirrors App.tsx) ──

interface SessionTx {
  hash: string;
  type: string;
  amount: string;
  detail: string;
  time: number;
}

interface ChainTx {
  txHash: string;
  type: string;
  amount: string;
  counterparty: string;
  timestamp: string;
}

function mergeAndDedup(
  sessionTxs: SessionTx[],
  chainTxs: ChainTx[],
  limit: number = 10
) {
  const sessionItems = sessionTxs.map((s) => ({
    hash: s.hash,
    sortTime: s.time,
    source: "session" as const,
  }));

  const chainItems = chainTxs.map((tx) => ({
    hash: tx.txHash,
    sortTime: tx.timestamp ? new Date(tx.timestamp).getTime() : 0,
    source: "chain" as const,
  }));

  const seen = new Set<string>();
  return [...sessionItems, ...chainItems]
    .sort((a, b) => b.sortTime - a.sortTime)
    .filter((item) => {
      if (seen.has(item.hash)) return false;
      seen.add(item.hash);
      return true;
    })
    .slice(0, limit);
}

// ── Velocity monitor logic ──

const VELOCITY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const VELOCITY_THRESHOLD = 5;

function checkVelocity(timestamps: number[]): {
  count: number;
  warning: boolean;
} {
  const cutoff = Date.now() - VELOCITY_WINDOW_MS;
  const count = timestamps.filter((t) => t > cutoff).length;
  return { count, warning: count >= VELOCITY_THRESHOLD };
}

// ── Tests ──

describe("UI: getTimeAgo", () => {
  it("returns 'just now' for timestamps < 1 min ago", () => {
    const ts = new Date(Date.now() - 30_000).toISOString();
    expect(getTimeAgo(ts)).toBe("just now");
  });

  it("returns minutes for recent timestamps", () => {
    const ts = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(getTimeAgo(ts)).toBe("5m ago");
  });

  it("returns hours for older timestamps", () => {
    const ts = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    expect(getTimeAgo(ts)).toBe("3h ago");
  });

  it("returns days for multi-day timestamps", () => {
    const ts = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    expect(getTimeAgo(ts)).toBe("7d ago");
  });

  it("returns date string for 30+ day timestamps", () => {
    const ts = new Date(Date.now() - 45 * 24 * 60 * 60_000).toISOString();
    const result = getTimeAgo(ts);
    // Should be a formatted date, not "Xd ago"
    expect(result).not.toContain("d ago");
    expect(result).toMatch(/\d/); // contains some digit (date)
  });
});

describe("UI: Explorer URLs", () => {
  it("builds correct tx URL", () => {
    const url = buildTxUrl("ABC123DEF456");
    expect(url).toBe(
      "https://solomentelabs.com/explorer.html?tx=ABC123DEF456"
    );
  });

  it("builds correct address URL", () => {
    const url = buildAddressUrl("core1d87pe85juh95t43x83p6es43rkgvyrtyut5yp3");
    expect(url).toBe(
      "https://solomentelabs.com/explorer.html?address=core1d87pe85juh95t43x83p6es43rkgvyrtyut5yp3"
    );
  });

  it("never uses coreum.dev", () => {
    const txUrl = buildTxUrl("hash123");
    const addrUrl = buildAddressUrl("core1abc");
    expect(txUrl).not.toContain("coreum.dev");
    expect(addrUrl).not.toContain("coreum.dev");
  });
});

describe("UI: Session Tx Merge + Dedup", () => {
  it("merges session and chain txs sorted by time", () => {
    const session: SessionTx[] = [
      { hash: "sess1", type: "send", amount: "1 CORE", detail: "", time: 1000 },
    ];
    const chain: ChainTx[] = [
      { txHash: "chain1", type: "receive", amount: "2", counterparty: "core1...", timestamp: new Date(2000).toISOString() },
    ];

    const merged = mergeAndDedup(session, chain);
    expect(merged.length).toBe(2);
    expect(merged[0].hash).toBe("chain1"); // newer (time 2000)
    expect(merged[1].hash).toBe("sess1"); // older (time 1000)
  });

  it("deduplicates by hash (session takes priority by sort order)", () => {
    const now = Date.now();
    const session: SessionTx[] = [
      { hash: "SAME_HASH", type: "send", amount: "1", detail: "", time: now },
    ];
    const chain: ChainTx[] = [
      { txHash: "SAME_HASH", type: "send", amount: "1", counterparty: "", timestamp: new Date(now - 60_000).toISOString() },
    ];

    const merged = mergeAndDedup(session, chain);
    expect(merged.length).toBe(1);
    expect(merged[0].source).toBe("session"); // session is newer
  });

  it("respects the limit", () => {
    const session: SessionTx[] = Array.from({ length: 15 }, (_, i) => ({
      hash: `tx${i}`,
      type: "send",
      amount: "1",
      detail: "",
      time: Date.now() - i * 1000,
    }));

    const merged = mergeAndDedup(session, [], 10);
    expect(merged.length).toBe(10);
  });

  it("handles empty inputs", () => {
    expect(mergeAndDedup([], []).length).toBe(0);
  });
});

describe("UI: Velocity Monitor", () => {
  it("returns 0 count with no timestamps", () => {
    const result = checkVelocity([]);
    expect(result.count).toBe(0);
    expect(result.warning).toBe(false);
  });

  it("counts only timestamps within the 10-min window", () => {
    const now = Date.now();
    const timestamps = [
      now - 1000,           // 1 sec ago — in window
      now - 5 * 60_000,     // 5 min ago — in window
      now - 15 * 60_000,    // 15 min ago — outside
    ];
    const result = checkVelocity(timestamps);
    expect(result.count).toBe(2);
    expect(result.warning).toBe(false);
  });

  it("triggers warning at threshold (5 in 10 min)", () => {
    const now = Date.now();
    const timestamps = Array.from({ length: 5 }, (_, i) => now - i * 60_000);
    const result = checkVelocity(timestamps);
    expect(result.count).toBe(5);
    expect(result.warning).toBe(true);
  });

  it("triggers warning above threshold", () => {
    const now = Date.now();
    const timestamps = Array.from({ length: 8 }, (_, i) => now - i * 30_000);
    const result = checkVelocity(timestamps);
    expect(result.warning).toBe(true);
  });
});
