/**
 * compliance.test.ts — Compliance Module Tests
 *
 * Tests address validation, cross-chain detection, transfer limits,
 * and network mismatch detection.
 */

import { describe, it, expect } from "vitest";
import { checkCompliance } from "../compliance";

// ── Valid Coreum Addresses (real format) ──

const VALID_MAINNET = "core1d87pe85juh95t43x83p6es43rkgvyrtyut5yp3";
const VALID_TESTNET = "testcore1d87pe85juh95t43x83p6es43rkgvyrtyuaaaa22";

describe("Compliance: Address Format", () => {
  it("accepts valid mainnet address", () => {
    const r = checkCompliance(VALID_MAINNET, 1);
    expect(r.status).toBe("PASS");
  });

  it("accepts valid testnet address", () => {
    const r = checkCompliance(VALID_TESTNET, 1);
    expect(r.status).toBe("PASS");
  });

  it("rejects empty recipient", () => {
    const r = checkCompliance("", 1);
    expect(r.status).toBe("FAIL");
    expect(r.reason).toContain("empty");
  });

  it("rejects whitespace-only", () => {
    const r = checkCompliance("   ", 1);
    expect(r.status).toBe("FAIL");
  });

  it("rejects address with spaces (paste artifacts)", () => {
    const r = checkCompliance("core1 d87pe85juh95t43x83p6es43rkgvyrtyut5yp3", 1);
    expect(r.status).toBe("FAIL");
    expect(r.reason).toContain("spaces");
  });

  it("rejects truncated address", () => {
    const r = checkCompliance("core1d87pe", 1);
    expect(r.status).toBe("FAIL");
    expect(r.reason).toContain("short");
  });

  it("rejects address with uppercase (invalid bech32)", () => {
    const r = checkCompliance("core1D87PE85JUH95T43X83P6ES43RKGVYRTYUT5YP3", 1);
    expect(r.status).toBe("FAIL");
    expect(r.reason).toContain("Invalid characters");
  });
});

describe("Compliance: Cross-Chain Detection", () => {
  it("rejects Cosmos Hub address", () => {
    const r = checkCompliance("cosmos1abc123def456ghi789jkl012mno345pqr678stu", 1);
    expect(r.status).toBe("FAIL");
    expect(r.reason).toContain("Cosmos Hub");
  });

  it("rejects Osmosis address", () => {
    const r = checkCompliance("osmo1abc123def456ghi789jkl012mno345pqr678stuvw", 1);
    expect(r.status).toBe("FAIL");
    expect(r.reason).toContain("Osmosis");
  });

  it("rejects Ethereum hex address", () => {
    const r = checkCompliance("0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18", 1);
    expect(r.status).toBe("FAIL");
    expect(r.reason).toContain("Ethereum");
  });

  it("rejects Injective address", () => {
    const r = checkCompliance("inj1abc123def456ghi789jkl012mno345pqr678stuvw", 1);
    expect(r.status).toBe("FAIL");
    expect(r.reason).toContain("Injective");
  });

  it("rejects random non-Coreum prefix", () => {
    const r = checkCompliance("randomprefix1abcdefgh", 1);
    expect(r.status).toBe("FAIL");
    expect(r.reason).toContain("Invalid address");
  });
});

describe("Compliance: Network Mismatch", () => {
  it("rejects testnet address on mainnet", () => {
    const r = checkCompliance(VALID_TESTNET, 1, "mainnet");
    expect(r.status).toBe("FAIL");
    expect(r.reason).toContain("testnet address");
  });

  it("allows mainnet address on mainnet", () => {
    const r = checkCompliance(VALID_MAINNET, 1, "mainnet");
    expect(r.status).toBe("PASS");
  });

  it("allows testnet address on testnet", () => {
    const r = checkCompliance(VALID_TESTNET, 1, "testnet");
    expect(r.status).toBe("PASS");
  });
});

describe("Compliance: Transfer Limits", () => {
  it("rejects zero amount", () => {
    const r = checkCompliance(VALID_MAINNET, 0);
    expect(r.status).toBe("FAIL");
    expect(r.reason).toContain("greater than 0");
  });

  it("rejects negative amount", () => {
    const r = checkCompliance(VALID_MAINNET, -5);
    expect(r.status).toBe("FAIL");
  });

  it("allows amount within limit", () => {
    const r = checkCompliance(VALID_MAINNET, 9999);
    expect(r.status).toBe("PASS");
  });

  it("rejects amount over 10,000 limit", () => {
    const r = checkCompliance(VALID_MAINNET, 10001);
    expect(r.status).toBe("FAIL");
    expect(r.reason).toContain("transfer limit");
  });

  it("allows exactly 10,000", () => {
    const r = checkCompliance(VALID_MAINNET, 10000);
    expect(r.status).toBe("PASS");
  });
});
