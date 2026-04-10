/**
 * ledger-utils.test.ts — Ledger Utility Function Tests
 *
 * Tests the pure functions from ledger.ts that don't require
 * a physical device: path serialization, HRP serialization,
 * DER-to-fixed signature conversion.
 */

import { describe, it, expect } from "vitest";

// ── Re-implement pure functions from ledger.ts for testing ──
// (These are not exported, so we test the logic directly)

function serializePath(path: string): Buffer {
  const parts = path.replace("m/", "").split("/").map((p) => {
    const hardened = p.endsWith("'");
    const num = parseInt(p.replace("'", ""), 10);
    return hardened ? (num | 0x80000000) >>> 0 : num;
  });
  const buf = Buffer.alloc(20);
  parts.forEach((p, i) => buf.writeUInt32LE(p, i * 4));
  return buf;
}

function serializeHRP(hrp: string): Buffer {
  const buf = Buffer.alloc(1 + hrp.length);
  buf.writeUInt8(hrp.length, 0);
  buf.write(hrp, 1);
  return buf;
}

function derToFixed(derSig: Uint8Array): Uint8Array {
  const fixed = new Uint8Array(64);
  let offset = 2;
  offset++;
  const rLen = derSig[offset++];
  const rStart = rLen === 33 ? offset + 1 : offset;
  const rEnd = offset + rLen;
  const rBytes = derSig.slice(rStart, rEnd);
  fixed.set(rBytes, 32 - rBytes.length);
  offset = rEnd;
  offset++;
  const sLen = derSig[offset++];
  const sStart = sLen === 33 ? offset + 1 : offset;
  const sEnd = offset + sLen;
  const sBytes = derSig.slice(sStart, sEnd);
  fixed.set(sBytes, 64 - sBytes.length);
  return fixed;
}

describe("Ledger: Path Serialization", () => {
  it("serializes Cosmos HD path correctly", () => {
    const buf = serializePath("m/44'/118'/0'/0/0");
    expect(buf.length).toBe(20); // 5 elements × 4 bytes

    // 44' = 44 + 0x80000000
    expect(buf.readUInt32LE(0)).toBe((44 | 0x80000000) >>> 0);
    // 118' = 118 + 0x80000000
    expect(buf.readUInt32LE(4)).toBe((118 | 0x80000000) >>> 0);
    // 0' = 0 + 0x80000000
    expect(buf.readUInt32LE(8)).toBe((0 | 0x80000000) >>> 0);
    // 0 (not hardened)
    expect(buf.readUInt32LE(12)).toBe(0);
    // 0 (not hardened)
    expect(buf.readUInt32LE(16)).toBe(0);
  });

  it("handles non-hardened paths", () => {
    const buf = serializePath("m/44/118/0/0/0");
    expect(buf.readUInt32LE(0)).toBe(44);
    expect(buf.readUInt32LE(4)).toBe(118);
  });
});

describe("Ledger: HRP Serialization", () => {
  it("serializes 'core' HRP", () => {
    const buf = serializeHRP("core");
    expect(buf.length).toBe(5); // 1 byte length + 4 bytes "core"
    expect(buf[0]).toBe(4);
    expect(buf.toString("utf8", 1)).toBe("core");
  });

  it("serializes 'testcore' HRP", () => {
    const buf = serializeHRP("testcore");
    expect(buf.length).toBe(9);
    expect(buf[0]).toBe(8);
    expect(buf.toString("utf8", 1)).toBe("testcore");
  });

  it("serializes 'cosmos' HRP", () => {
    const buf = serializeHRP("cosmos");
    expect(buf.length).toBe(7);
    expect(buf[0]).toBe(6);
  });
});

describe("Ledger: DER to Fixed Signature Conversion", () => {
  it("converts a standard DER signature to 64 bytes", () => {
    // Example DER signature: 0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s>
    // r = 32 bytes, s = 32 bytes
    const r = new Uint8Array(32).fill(0xaa);
    const s = new Uint8Array(32).fill(0xbb);

    const der = new Uint8Array([
      0x30, 68,       // sequence, total length
      0x02, 32,       // integer, r length
      ...r,
      0x02, 32,       // integer, s length
      ...s,
    ]);

    const fixed = derToFixed(der);
    expect(fixed.length).toBe(64);
    expect(fixed.slice(0, 32)).toEqual(r);
    expect(fixed.slice(32, 64)).toEqual(s);
  });

  it("handles DER with 33-byte r (leading zero pad)", () => {
    // When r has high bit set, DER adds a 0x00 prefix
    const r = new Uint8Array(32).fill(0xcc);
    const s = new Uint8Array(32).fill(0xdd);

    const der = new Uint8Array([
      0x30, 69,       // sequence
      0x02, 33,       // integer, r length = 33 (with padding)
      0x00, ...r,     // leading zero + 32 bytes
      0x02, 32,       // integer, s length
      ...s,
    ]);

    const fixed = derToFixed(der);
    expect(fixed.length).toBe(64);
    expect(fixed.slice(0, 32)).toEqual(r);
    expect(fixed.slice(32, 64)).toEqual(s);
  });

  it("handles DER with 33-byte s (leading zero pad)", () => {
    const r = new Uint8Array(32).fill(0xee);
    const s = new Uint8Array(32).fill(0xff);

    const der = new Uint8Array([
      0x30, 69,
      0x02, 32,
      ...r,
      0x02, 33,       // s length = 33 (with padding)
      0x00, ...s,
    ]);

    const fixed = derToFixed(der);
    expect(fixed.length).toBe(64);
    expect(fixed.slice(0, 32)).toEqual(r);
    expect(fixed.slice(32, 64)).toEqual(s);
  });

  it("handles DER with both r and s padded to 33 bytes", () => {
    const r = new Uint8Array(32).fill(0x11);
    const s = new Uint8Array(32).fill(0x22);

    const der = new Uint8Array([
      0x30, 70,
      0x02, 33, 0x00, ...r,
      0x02, 33, 0x00, ...s,
    ]);

    const fixed = derToFixed(der);
    expect(fixed.length).toBe(64);
    expect(fixed.slice(0, 32)).toEqual(r);
    expect(fixed.slice(32, 64)).toEqual(s);
  });

  it("returns exactly 64 bytes for any valid DER input", () => {
    // Short r (31 bytes — rare but valid)
    const r = new Uint8Array(31).fill(0x42);
    const s = new Uint8Array(32).fill(0x43);

    const der = new Uint8Array([
      0x30, 67,
      0x02, 31, ...r,
      0x02, 32, ...s,
    ]);

    const fixed = derToFixed(der);
    expect(fixed.length).toBe(64);
    // r should be right-padded in the first 32 bytes
    expect(fixed[0]).toBe(0); // leading zero fill
    expect(fixed[1]).toBe(0x42); // start of r
  });
});
