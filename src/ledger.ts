/**
 * ledger.ts — Ledger Device Connection + Signing
 *
 * Connects via WebUSB, derives Coreum address using the Cosmos
 * HD path, and signs transactions with the Ledger device.
 */

import TransportWebUSB from "@ledgerhq/hw-transport-webusb";
import CosmosApp from "@ledgerhq/hw-app-cosmos";

// Cosmos HD path for Coreum: m/44'/990'/0'/0/0
// 990 = Coreum coin type
const COREUM_HD_PATH = "m/44'/990'/0'/0/0";

export interface LedgerConnection {
  transport: any;
  app: CosmosApp;
  address: string;
  publicKey: Uint8Array;
}

/**
 * Connect to Ledger device and derive Coreum address.
 */
export async function connectLedger(
  prefix: string = "testcore"
): Promise<LedgerConnection> {
  // Request USB device access
  const transport = await TransportWebUSB.create();

  // Open Cosmos app on Ledger
  const app = new CosmosApp(transport as any);

  // Get public key + address from device
  const response = await app.getAddress(COREUM_HD_PATH, prefix);

  const pubKeyHex = (response as any).pubKey || (response as any).publicKey || "";
  const address = (response as any).bech32Address || (response as any).address || "";

  if (!pubKeyHex) {
    throw new Error("Failed to get public key from Ledger. Is the Cosmos app open?");
  }

  // Convert hex public key to Uint8Array
  const publicKey = hexToBytes(pubKeyHex);

  return {
    transport,
    app,
    address,
    publicKey,
  };
}

/**
 * Sign a transaction using the Ledger device.
 * Returns the signature bytes.
 */
export async function signWithLedger(
  app: CosmosApp,
  signDoc: string
): Promise<Uint8Array> {
  const response = await app.sign(COREUM_HD_PATH, signDoc);

  const sigHex = (response as any).signature;
  if (!sigHex) {
    throw new Error("Transaction was rejected on the Ledger device");
  }

  // The signature from Ledger is DER-encoded, convert to fixed 64-byte format
  const sigBytes = hexToBytes(sigHex);
  return derToFixed(sigBytes);
}

/**
 * Convert hex string to Uint8Array.
 */
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Convert DER-encoded signature to fixed 64-byte (r || s) format.
 */
function derToFixed(derSig: Uint8Array): Uint8Array {
  const fixed = new Uint8Array(64);

  // DER format: 0x30 <len> 0x02 <rLen> <r> 0x02 <sLen> <s>
  let offset = 2; // skip 0x30 and total length

  // Parse r
  offset++; // skip 0x02
  const rLen = derSig[offset++];
  const rStart = rLen === 33 ? offset + 1 : offset; // skip leading 0x00 if 33 bytes
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
 * Disconnect from Ledger device.
 */
export async function disconnectLedger(transport: any): Promise<void> {
  try {
    await transport.close();
  } catch {
    // Ignore close errors
  }
}
