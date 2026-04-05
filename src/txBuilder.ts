/**
 * txBuilder.ts — Transaction Builder for Coreum
 *
 * Builds a MsgSend transaction in Amino JSON format for Ledger signing,
 * then assembles the signed transaction bytes for broadcast.
 */

import { makeSignDoc, type StdFee, type AminoMsg } from "@cosmjs/amino";
import { TxRaw } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { makeAuthInfoBytes, Registry, encodePubkey } from "@cosmjs/proto-signing";
import { Int53 } from "@cosmjs/math";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { encodeSecp256k1Pubkey } from "@cosmjs/amino";

// Register MsgSend
const registry = new Registry();
registry.register("/cosmos.bank.v1beta1.MsgSend", MsgSend);

export interface SendTxParams {
  fromAddress: string;
  toAddress: string;
  amount: string; // in micro units (e.g. "1000000" = 1 COREUM)
  denom: string;
  chainId: string;
  accountNumber: number;
  sequence: number;
  memo?: string;
}

/**
 * Build an Amino sign doc for a MsgSend transaction.
 * This is what the Ledger device will display and sign.
 */
export function buildAminoSignDoc(params: SendTxParams): {
  signDoc: ReturnType<typeof makeSignDoc>;
  signDocString: string;
} {
  const msg: AminoMsg = {
    type: "cosmos-sdk/MsgSend",
    value: {
      from_address: params.fromAddress,
      to_address: params.toAddress,
      amount: [
        {
          denom: params.denom,
          amount: params.amount,
        },
      ],
    },
  };

  const fee: StdFee = {
    amount: [{ denom: params.denom, amount: "50000" }],
    gas: "200000",
  };

  const signDoc = makeSignDoc(
    [msg],
    fee,
    params.chainId,
    params.memo || "",
    params.accountNumber,
    params.sequence
  );

  // Serialize to JSON string for Ledger signing
  const signDocString = JSON.stringify(sortObject(signDoc));

  return { signDoc, signDocString };
}

/**
 * Assemble signed transaction bytes for broadcast.
 */
export function assembleTxBytes(
  signDoc: ReturnType<typeof makeSignDoc>,
  signature: Uint8Array,
  publicKey: Uint8Array
): Uint8Array {
  // Build TxBody
  const txBody = {
    typeUrl: "/cosmos.tx.v1beta1.TxBody",
    value: {
      messages: signDoc.msgs.map((msg: any) => ({
        typeUrl: "/cosmos.bank.v1beta1.MsgSend",
        value: {
          fromAddress: msg.value.from_address,
          toAddress: msg.value.to_address,
          amount: msg.value.amount,
        },
      })),
      memo: signDoc.memo,
    },
  };

  // Encode TxBody
  const bodyBytes = registry.encode(txBody);

  // Build AuthInfo using proper CosmJS encoding
  const aminoPubkey = encodeSecp256k1Pubkey(publicKey);
  const pubkey = encodePubkey(aminoPubkey);

  const authInfoBytes = makeAuthInfoBytes(
    [
      {
        pubkey,
        sequence: Int53.fromString(signDoc.sequence).toNumber(),
      },
    ],
    signDoc.fee.amount,
    Int53.fromString(signDoc.fee.gas).toNumber(),
    undefined, // feeGranter
    undefined, // feePayer
    127 // signMode: SIGN_MODE_LEGACY_AMINO_JSON (127, not 1)
  );

  const txRaw = TxRaw.fromPartial({
    bodyBytes,
    authInfoBytes,
    signatures: [signature],
  });

  return TxRaw.encode(txRaw).finish();
}

/**
 * Convert COREUM amount to micro units.
 */
export function toMicroAmount(amount: number): string {
  return Math.floor(amount * 1_000_000).toString();
}

/**
 * Sort object keys recursively (required for Amino JSON determinism).
 */
function sortObject(obj: any): any {
  if (Array.isArray(obj)) return obj.map(sortObject);
  if (obj === null || typeof obj !== "object") return obj;

  const sorted: any = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortObject(obj[key]);
  }
  return sorted;
}
