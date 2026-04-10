/**
 * ledger.ts — Ledger Device Connection + Signing
 *
 * Connects via WebUSB, derives Coreum address using the Cosmos
 * HD path, and signs transactions with the Ledger device.
 * Uses @zondax/ledger-cosmos-js for address derivation,
 * raw APDU for signing (Cosmos app v2.34+ compatible).
 */

import TransportWebUSB from "@ledgerhq/hw-transport-webusb";
import CosmosApp from "@zondax/ledger-cosmos-js";

const COREUM_PATH = "m/44'/118'/0'/0/0";
const CLA = 0x55;
const INS_SIGN = 0x02;
const CHUNK_SIZE = 250;

export interface LedgerConnection {
  transport: any;
  app: any;
  address: string;
  publicKey: Uint8Array;
  prefix: string;
}

/**
 * Serialize BIP44 path to bytes (5 elements, 4 bytes each = 20 bytes).
 */
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

/**
 * Serialize HRP (human readable part) for Cosmos app.
 */
function serializeHRP(hrp: string): Buffer {
  const buf = Buffer.alloc(1 + hrp.length);
  buf.writeUInt8(hrp.length, 0);
  buf.write(hrp, 1);
  return buf;
}

/**
 * Connect to Ledger device and derive Coreum address.
 */
export async function connectLedger(
  prefix: string = "testcore"
): Promise<LedgerConnection> {
  // Try to reuse an already-paired Ledger device (avoids USB reset error)
  let transport;
  try {
    const usb = (navigator as any).usb;
    if (usb) {
      const devices: any[] = await usb.getDevices();
      const ledger = devices.find((d: any) => d.vendorId === 0x2c97);
      if (ledger) {
        transport = await TransportWebUSB.open(ledger);
      }
    }
  } catch {
    // Fallback to create() below
  }
  if (!transport) {
    try {
      transport = await TransportWebUSB.create();
    } catch (e: any) {
      // "Unable to reset the device" is a known Chrome WebUSB quirk — retry once
      if (e?.message?.includes("reset")) {
        console.warn("[Ledger] USB reset failed, retrying...");
        await new Promise((r) => setTimeout(r, 600));
        transport = await TransportWebUSB.create();
      } else {
        throw e;
      }
    }
  }
  const app = new CosmosApp(transport as any);

  // Check app version
  try {
    const versionResponse = await transport.send(CLA, 0x00, 0, 0);
    const major = versionResponse[1];
    const minor = versionResponse[2];
    const patch = versionResponse[3];
    console.log(`[Ledger] Cosmos app version: ${major}.${minor}.${patch}`);
  } catch (e) {
    console.log("[Ledger] Version check failed:", e);
  }

  // Get address
  let response: any;
  try {
    response = await app.getAddressAndPubKey(COREUM_PATH, prefix);
    console.log("[Ledger] Address response keys:", Object.keys(response));
  } catch (e: any) {
    console.log(`[Ledger] getAddress with "${prefix}" failed:`, e.message);
    response = await app.getAddressAndPubKey(COREUM_PATH, "cosmos");
    console.log("[Ledger] Fallback address response keys:", Object.keys(response));
  }

  const returnCode = response.return_code ?? response.returnCode;
  if (returnCode && returnCode !== 0x9000) {
    throw new Error(`Ledger: ${response.error_message || "UNKNOWN_ERROR"} (0x${returnCode.toString(16)})`);
  }

  const address = response.bech32_address ?? response.address ?? "";
  const pk = response.compressed_pk ?? response.compressedPk ?? response.publicKey;

  // Ensure we get the raw bytes correctly regardless of Buffer type
  let publicKey: Uint8Array;
  if (pk instanceof Uint8Array) {
    publicKey = new Uint8Array(pk);  // Copy to avoid offset issues
  } else if (pk?.buffer) {
    publicKey = new Uint8Array(pk.buffer.slice(pk.byteOffset, pk.byteOffset + pk.byteLength));
  } else {
    publicKey = new Uint8Array();
  }
  console.log("[Ledger] PubKey hex:", Array.from(publicKey).map((b: number) => b.toString(16).padStart(2, "0")).join(""));
  console.log("[Ledger] PubKey length:", publicKey.length, "first byte:", publicKey[0]);

  if (!address) {
    throw new Error("Failed to get address from Ledger. Is the Cosmos app open?");
  }

  return { transport, app, address, publicKey, prefix };
}

/**
 * Sign a transaction using raw APDU commands.
 * This bypasses the Zondax wrapper which hangs on Cosmos app v2.34+.
 */
export async function signWithLedger(
  app: any,
  signDoc: string,
  hrp: string = "core"
): Promise<Uint8Array> {
  const transport = app.transport;

  // Prepare message buffer: HRP + path + message
  const hrpBuf = serializeHRP(hrp);
  const pathBuf = serializePath(COREUM_PATH);
  const messageBuf = Buffer.from(signDoc);

  // Split into chunks
  // Try path-only first chunk (old Cosmos app sign protocol)
  const chunks: Buffer[] = [];

  // First chunk: path only (no HRP for sign — HRP is only for getAddress)
  chunks.push(pathBuf);

  // Remaining chunks: message data
  for (let i = 0; i < messageBuf.length; i += CHUNK_SIZE) {
    chunks.push(messageBuf.subarray(i, i + CHUNK_SIZE));
  }

  console.log(`[Ledger] Signing: ${chunks.length} chunks, message length: ${messageBuf.length}`);

  let response: Buffer;

  for (let i = 0; i < chunks.length; i++) {
    const isFirst = i === 0;
    const isLast = i === chunks.length - 1;

    // P1: 0x00 = init, 0x01 = add, 0x02 = last
    const p1 = isFirst ? 0x00 : isLast ? 0x02 : 0x01;
    // P2: 0x00 = JSON (Amino), 0x01 = Textual
    const p2 = 0x00;

    console.log(`[Ledger] Sending chunk ${i + 1}/${chunks.length} (p1=${p1}, size=${chunks[i].length})`);

    try {
      response = await transport.send(CLA, INS_SIGN, p1, p2, chunks[i]);
      console.log(`[Ledger] Chunk ${i + 1} response: ${response.length} bytes, SW: 0x${response.slice(-2).toString("hex")}`);
    } catch (e: any) {
      console.log(`[Ledger] Chunk ${i + 1} error:`, e.message);
      if (e.statusCode === 0x6986 || e.message?.includes("0x6986")) {
        throw new Error("Transaction rejected on Ledger device");
      }
      throw new Error(`Ledger sign failed at chunk ${i + 1}: ${e.message}`);
    }
  }

  // Extract signature from last response (remove 2-byte status code)
  const sigBytes = response!.slice(0, response!.length - 2);
  console.log(`[Ledger] Signature: ${sigBytes.length} bytes`);

  if (sigBytes.length === 0) {
    throw new Error("Empty signature returned from Ledger");
  }

  // Log raw signature for debugging
  const rawSig = new Uint8Array(sigBytes);
  console.log("[Ledger] Raw sig hex:", Array.from(rawSig).map(b => b.toString(16).padStart(2, "0")).join(""));
  console.log("[Ledger] First byte:", rawSig[0], "= 0x" + rawSig[0].toString(16));

  // Check if DER-encoded (starts with 0x30) or already fixed 64-byte
  if (rawSig.length === 64) {
    console.log("[Ledger] Signature is already 64 bytes (fixed format)");
    return rawSig;
  }

  if (rawSig[0] === 0x30) {
    console.log("[Ledger] Signature is DER-encoded, converting to fixed 64-byte");
    return derToFixed(rawSig);
  }

  console.log("[Ledger] Unknown signature format, attempting DER decode");
  return derToFixed(rawSig);
}

/**
 * Convert DER-encoded signature to fixed 64-byte (r || s) format.
 */
function derToFixed(derSig: Uint8Array): Uint8Array {
  const fixed = new Uint8Array(64);

  let offset = 2; // skip 0x30 and total length

  // Parse r
  offset++; // skip 0x02
  const rLen = derSig[offset++];
  const rStart = rLen === 33 ? offset + 1 : offset;
  const rEnd = offset + rLen;
  const rBytes = derSig.slice(rStart, rEnd);
  fixed.set(rBytes, 32 - rBytes.length);
  offset = rEnd;

  // Parse s
  offset++; // skip 0x02
  const sLen = derSig[offset++];
  const sStart = sLen === 33 ? offset + 1 : offset;
  const sEnd = offset + sLen;
  const sBytes = derSig.slice(sStart, sEnd);
  fixed.set(sBytes, 64 - sBytes.length);

  return fixed;
}

/**
 * Try to auto-reconnect to a previously authorized Ledger device.
 * Uses navigator.usb.getDevices() which returns devices the user
 * has already granted permission to — no user gesture required.
 * Returns null if no authorized device is found or connection fails.
 */
export async function tryAutoConnect(
  prefix: string = "testcore"
): Promise<LedgerConnection | null> {
  try {
    // Check if WebUSB is available
    const usb = (navigator as any).usb;
    if (!usb?.getDevices) return null;

    // Get previously authorized devices (no user gesture needed)
    const devices: any[] = await usb.getDevices();
    const ledgerDevice = devices.find(
      (d: any) => d.vendorId === 0x2c97 // Ledger vendor ID
    );

    if (!ledgerDevice) return null;

    console.log("[Ledger] Found previously authorized device, auto-connecting...");

    // Release any stale USB handle from a previous session
    if (ledgerDevice.opened) {
      console.log("[Ledger] Device has stale handle, closing first...");
      try {
        await ledgerDevice.close();
      } catch (e) {
        console.log("[Ledger] Stale close failed (expected):", (e as Error).message);
      }
      // Brief pause to let the USB stack settle
      await new Promise((r) => setTimeout(r, 500));
    }

    // Open transport using the already-authorized device
    let transport;
    try {
      transport = await TransportWebUSB.open(ledgerDevice);
    } catch (openErr) {
      // If open fails, try one more time after a reset attempt
      console.log("[Ledger] First open failed, retrying after reset...");
      try {
        await ledgerDevice.open();
        await ledgerDevice.close();
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 500));
      transport = await TransportWebUSB.open(ledgerDevice);
    }
    const app = new CosmosApp(transport as any);

    // Check app version to verify Cosmos app is open
    try {
      const versionResponse = await transport.send(CLA, 0x00, 0, 0);
      const major = versionResponse[1];
      const minor = versionResponse[2];
      const patch = versionResponse[3];
      console.log(`[Ledger] Auto-connect: Cosmos app version: ${major}.${minor}.${patch}`);
    } catch {
      // Cosmos app not open — close transport and bail
      console.log("[Ledger] Auto-connect: Cosmos app not open, skipping");
      await transport.close();
      return null;
    }

    // Get address
    let response: any;
    try {
      response = await app.getAddressAndPubKey(COREUM_PATH, prefix);
    } catch {
      try {
        response = await app.getAddressAndPubKey(COREUM_PATH, "cosmos");
      } catch {
        await transport.close();
        return null;
      }
    }

    const returnCode = response.return_code ?? response.returnCode;
    if (returnCode && returnCode !== 0x9000) {
      await transport.close();
      return null;
    }

    const address = response.bech32_address ?? response.address ?? "";
    const pk = response.compressed_pk ?? response.compressedPk ?? response.publicKey;

    let publicKey: Uint8Array;
    if (pk instanceof Uint8Array) {
      publicKey = new Uint8Array(pk);
    } else if (pk?.buffer) {
      publicKey = new Uint8Array(pk.buffer.slice(pk.byteOffset, pk.byteOffset + pk.byteLength));
    } else {
      publicKey = new Uint8Array();
    }

    if (!address) {
      await transport.close();
      return null;
    }

    console.log(`[Ledger] Auto-connected: ${address}`);
    return { transport, app, address, publicKey, prefix };
  } catch (err) {
    console.log("[Ledger] Auto-connect failed (silent):", (err as Error).message);
    return null;
  }
}

/**
 * Disconnect from Ledger device.
 */
export async function disconnectLedger(transport: any): Promise<void> {
  try {
    await transport.close();
  } catch {
    // Ignore close errors
  }
}
