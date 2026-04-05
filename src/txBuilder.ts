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
import { MsgDelegate, MsgUndelegate } from "cosmjs-types/cosmos/staking/v1beta1/tx";
import { MsgWithdrawDelegatorReward } from "cosmjs-types/cosmos/distribution/v1beta1/tx";
import { encodeSecp256k1Pubkey } from "@cosmjs/amino";

// Register MsgSend
const registry = new Registry();
registry.register("/cosmos.bank.v1beta1.MsgSend", MsgSend);
registry.register("/cosmos.staking.v1beta1.MsgDelegate", MsgDelegate);
registry.register("/cosmos.staking.v1beta1.MsgUndelegate", MsgUndelegate);
registry.register("/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward", MsgWithdrawDelegatorReward);

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

// ─── Staking Transaction Builders ────────────────────────────────────

export interface StakeTxParams {
  delegatorAddress: string;
  validatorAddress: string;
  amount: string; // micro units
  denom: string;
  chainId: string;
  accountNumber: number;
  sequence: number;
  memo?: string;
}

/**
 * Build an Amino sign doc for a MsgDelegate transaction.
 */
export function buildDelegateSignDoc(params: StakeTxParams): {
  signDoc: ReturnType<typeof makeSignDoc>;
  signDocString: string;
} {
  const msg: AminoMsg = {
    type: "cosmos-sdk/MsgDelegate",
    value: {
      delegator_address: params.delegatorAddress,
      validator_address: params.validatorAddress,
      amount: {
        denom: params.denom,
        amount: params.amount,
      },
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

  const signDocString = JSON.stringify(sortObject(signDoc));

  return { signDoc, signDocString };
}

/**
 * Build an Amino sign doc for a MsgUndelegate transaction.
 */
export function buildUndelegateSignDoc(params: StakeTxParams): {
  signDoc: ReturnType<typeof makeSignDoc>;
  signDocString: string;
} {
  const msg: AminoMsg = {
    type: "cosmos-sdk/MsgUndelegate",
    value: {
      delegator_address: params.delegatorAddress,
      validator_address: params.validatorAddress,
      amount: {
        denom: params.denom,
        amount: params.amount,
      },
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

  const signDocString = JSON.stringify(sortObject(signDoc));

  return { signDoc, signDocString };
}

/**
 * Build an Amino sign doc for a MsgWithdrawDelegatorReward transaction.
 */
export function buildClaimRewardsSignDoc(params: {
  delegatorAddress: string;
  validatorAddress: string;
  chainId: string;
  accountNumber: number;
  sequence: number;
  denom: string;
  memo?: string;
}): {
  signDoc: ReturnType<typeof makeSignDoc>;
  signDocString: string;
} {
  const msg: AminoMsg = {
    type: "cosmos-sdk/MsgWithdrawDelegatorReward",
    value: {
      delegator_address: params.delegatorAddress,
      validator_address: params.validatorAddress,
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

  const signDocString = JSON.stringify(sortObject(signDoc));

  return { signDoc, signDocString };
}

/**
 * Assemble signed staking transaction bytes for broadcast.
 * Detects the Amino msg type and maps to the correct proto typeUrl and fields.
 */
export function assembleStakingTxBytes(
  signDoc: ReturnType<typeof makeSignDoc>,
  signature: Uint8Array,
  publicKey: Uint8Array
): Uint8Array {
  const aminoToProto: Record<string, { typeUrl: string; mapValue: (v: any) => any }> = {
    "cosmos-sdk/MsgDelegate": {
      typeUrl: "/cosmos.staking.v1beta1.MsgDelegate",
      mapValue: (v: any) => ({
        delegatorAddress: v.delegator_address,
        validatorAddress: v.validator_address,
        amount: v.amount,
      }),
    },
    "cosmos-sdk/MsgUndelegate": {
      typeUrl: "/cosmos.staking.v1beta1.MsgUndelegate",
      mapValue: (v: any) => ({
        delegatorAddress: v.delegator_address,
        validatorAddress: v.validator_address,
        amount: v.amount,
      }),
    },
    "cosmos-sdk/MsgWithdrawDelegatorReward": {
      typeUrl: "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward",
      mapValue: (v: any) => ({
        delegatorAddress: v.delegator_address,
        validatorAddress: v.validator_address,
      }),
    },
  };

  const txBody = {
    typeUrl: "/cosmos.tx.v1beta1.TxBody",
    value: {
      messages: signDoc.msgs.map((msg: any) => {
        const mapping = aminoToProto[msg.type];
        if (!mapping) {
          throw new Error(`Unknown Amino message type: ${msg.type}`);
        }
        return {
          typeUrl: mapping.typeUrl,
          value: mapping.mapValue(msg.value),
        };
      }),
      memo: signDoc.memo,
    },
  };

  const bodyBytes = registry.encode(txBody);

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
    127 // signMode: SIGN_MODE_LEGACY_AMINO_JSON
  );

  const txRaw = TxRaw.fromPartial({
    bodyBytes,
    authInfoBytes,
    signatures: [signature],
  });

  return TxRaw.encode(txRaw).finish();
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
