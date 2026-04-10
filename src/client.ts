/**
 * client.ts — Coreum RPC Client
 *
 * Connects to Coreum testnet/mainnet, fetches balances,
 * and broadcasts signed transactions.
 */

import { StargateClient } from "@cosmjs/stargate";

// Coreum endpoints
const COREUM_TESTNET_RPC = "https://full-node.testnet-1.coreum.dev:26657";
const COREUM_MAINNET_RPC = "https://full-node.mainnet-1.coreum.dev:26657";

// Denomination
const TESTNET_DENOM = "utestcore";
const MAINNET_DENOM = "ucore";

export interface BalanceInfo {
  amount: string;
  denom: string;
  display: string;
}

export interface BroadcastResult {
  success: boolean;
  txHash: string;
  error?: string;
}

let cachedClient: StargateClient | null = null;
let currentNetwork: "testnet" | "mainnet" = "testnet";

/**
 * Get or create a Stargate client for the current network.
 */
export async function getClient(
  network: "testnet" | "mainnet" = "testnet"
): Promise<StargateClient> {
  if (cachedClient && currentNetwork === network) {
    return cachedClient;
  }

  const rpc = network === "mainnet" ? COREUM_MAINNET_RPC : COREUM_TESTNET_RPC;
  cachedClient = await StargateClient.connect(rpc);
  currentNetwork = network;
  return cachedClient;
}

/**
 * Get the denom for the current network.
 */
export function getDenom(network: "testnet" | "mainnet" = "testnet"): string {
  return network === "mainnet" ? MAINNET_DENOM : TESTNET_DENOM;
}

/**
 * Get the address prefix for the current network.
 */
export function getPrefix(network: "testnet" | "mainnet" = "testnet"): string {
  return network === "mainnet" ? "core" : "testcore";
}

/**
 * Fetch COREUM balance for an address.
 */
export async function fetchBalance(
  address: string,
  network: "testnet" | "mainnet" = "testnet"
): Promise<BalanceInfo> {
  const client = await getClient(network);
  const denom = getDenom(network);

  const coin = await client.getBalance(address, denom);

  // Convert from micro units (1 COREUM = 1,000,000 utestcore)
  const amountNum = parseInt(coin.amount || "0") / 1_000_000;
  const display = amountNum.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });

  return {
    amount: coin.amount || "0",
    denom,
    display: `${display} CORE`,
  };
}

/**
 * Fetch account number and sequence for signing.
 */
export async function getAccountInfo(
  address: string,
  network: "testnet" | "mainnet" = "testnet"
): Promise<{ accountNumber: number; sequence: number }> {
  const client = await getClient(network);
  const account = await client.getAccount(address);

  if (!account) {
    throw new Error("Account not found on chain. Has it been funded?");
  }

  return {
    accountNumber: account.accountNumber,
    sequence: account.sequence,
  };
}

/**
 * Get the chain ID for the current network.
 */
export async function getChainId(
  network: "testnet" | "mainnet" = "testnet"
): Promise<string> {
  const client = await getClient(network);
  return await client.getChainId();
}

/**
 * Broadcast a signed transaction.
 */
export async function broadcastTx(
  txBytes: Uint8Array,
  network: "testnet" | "mainnet" = "testnet"
): Promise<BroadcastResult> {
  const client = await getClient(network);

  try {
    const result = await client.broadcastTx(txBytes);

    if (result.code !== 0) {
      return {
        success: false,
        txHash: result.transactionHash,
        error: `Transaction failed with code ${result.code}: ${result.rawLog}`,
      };
    }

    return {
      success: true,
      txHash: result.transactionHash,
    };
  } catch (err) {
    return {
      success: false,
      txHash: "",
      error: (err as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// Transaction Simulation
// ---------------------------------------------------------------------------

export interface SimulateResult {
  success: boolean;
  gasUsed: number;
  gasWanted: number;
  error?: string;
}

/**
 * Simulate a transaction before signing to estimate gas and catch errors.
 * Uses the Cosmos SDK /cosmos/tx/v1beta1/simulate endpoint.
 * Requires the sender's public key + sequence for the signer_info
 * (Cosmos SDK requires at least one signer even for simulation).
 */
export async function simulateTx(
  fromAddress: string,
  toAddress: string,
  amount: string,  // micro amount as string
  denom: string,
  network: "testnet" | "mainnet" = "testnet",
  publicKey?: Uint8Array,
  sequence?: number
): Promise<SimulateResult> {
  const base = network === "mainnet" ? MAINNET_REST : TESTNET_REST;

  // Base64-encode the public key for the REST API
  const pubKeyB64 = publicKey
    ? btoa(String.fromCharCode(...publicKey))
    : "";

  // Build a Cosmos SDK tx body with proper signer_info for simulation
  const simulateBody = {
    tx_bytes: "",
    tx: {
      body: {
        messages: [
          {
            "@type": "/cosmos.bank.v1beta1.MsgSend",
            from_address: fromAddress,
            to_address: toAddress,
            amount: [{ denom, amount }],
          },
        ],
        memo: "Sent via TX Web Wallet",
      },
      auth_info: {
        signer_infos: pubKeyB64 ? [
          {
            public_key: {
              "@type": "/cosmos.crypto.secp256k1.PubKey",
              key: pubKeyB64,
            },
            mode_info: { single: { mode: "SIGN_MODE_LEGACY_AMINO_JSON" } },
            sequence: String(sequence ?? 0),
          },
        ] : [],
        fee: { amount: [{ denom, amount: "50000" }], gas_limit: "200000" },
      },
      // One empty signature per signer (required by simulate)
      signatures: pubKeyB64 ? [""] : [],
    },
  };

  try {
    const res = await fetch(`${base}/cosmos/tx/v1beta1/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(simulateBody),
    });

    const data = await res.json();

    if (!res.ok || data.code) {
      return {
        success: false,
        gasUsed: 0,
        gasWanted: 0,
        error: data.message || data.error || `Simulation failed (HTTP ${res.status})`,
      };
    }

    return {
      success: true,
      gasUsed: parseInt(data.gas_info?.gas_used || "0", 10),
      gasWanted: parseInt(data.gas_info?.gas_wanted || "0", 10),
    };
  } catch (err) {
    return {
      success: false,
      gasUsed: 0,
      gasWanted: 0,
      error: (err as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// Staking REST API
// ---------------------------------------------------------------------------

const TESTNET_REST = "https://full-node.testnet-1.coreum.dev:1317";
const MAINNET_REST = "https://full-node.mainnet-1.coreum.dev:1317";

function getRestBase(network: "testnet" | "mainnet"): string {
  return network === "mainnet" ? MAINNET_REST : TESTNET_REST;
}

export interface ValidatorInfo {
  operatorAddress: string;
  moniker: string;
  commission: string; // e.g. "0.10" = 10%
  tokens: string; // total bonded tokens in micro
  status: string; // BOND_STATUS_BONDED etc
  jailed: boolean;
}

export interface DelegationInfo {
  validatorAddress: string;
  validatorMoniker: string;
  shares: string;
  balance: string; // micro amount
  rewards: string; // micro amount of pending rewards
}

/**
 * Fetch bonded validators from the REST API.
 * Returns validators sorted by tokens descending.
 */
export async function fetchValidators(
  network: "testnet" | "mainnet" = "testnet"
): Promise<ValidatorInfo[]> {
  const base = getRestBase(network);
  const url = `${base}/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=100`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`fetchValidators: HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    const validators: ValidatorInfo[] = (data.validators || []).map(
      (v: any) => ({
        operatorAddress: v.operator_address,
        moniker: v.description?.moniker || "Unknown",
        commission: v.commission?.commission_rates?.rate || "0",
        tokens: v.tokens || "0",
        status: v.status || "",
        jailed: v.jailed || false,
      })
    );

    // Sort by tokens descending
    validators.sort(
      (a, b) => parseFloat(b.tokens) - parseFloat(a.tokens)
    );

    return validators;
  } catch (err) {
    console.error("fetchValidators error:", err);
    return [];
  }
}

/**
 * Fetch delegations for an address.
 * Pass a pre-fetched validators array for efficient moniker lookup.
 */
export async function fetchDelegations(
  address: string,
  network: "testnet" | "mainnet" = "testnet",
  validators: ValidatorInfo[] = []
): Promise<DelegationInfo[]> {
  const base = getRestBase(network);
  const url = `${base}/cosmos/staking/v1beta1/delegations/${address}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`fetchDelegations: HTTP ${res.status}`);
      return [];
    }

    const data = await res.json();
    const monikerMap = new Map<string, string>();
    for (const v of validators) {
      monikerMap.set(v.operatorAddress, v.moniker);
    }

    const delegations: DelegationInfo[] = (
      data.delegation_responses || []
    ).map((entry: any) => ({
      validatorAddress: entry.delegation?.validator_address || "",
      validatorMoniker:
        monikerMap.get(entry.delegation?.validator_address || "") || "Unknown",
      shares: entry.delegation?.shares || "0",
      balance: entry.balance?.amount || "0",
      rewards: "0", // filled in by fetchStakingInfo
    }));

    return delegations;
  } catch (err) {
    console.error("fetchDelegations error:", err);
    return [];
  }
}

/**
 * Fetch pending staking rewards for a delegator.
 * Returns a Map of validator_address → reward amount, plus totalRewards.
 */
export async function fetchRewards(
  address: string,
  network: "testnet" | "mainnet" = "testnet"
): Promise<{ rewardsMap: Map<string, string>; totalRewards: string }> {
  const base = getRestBase(network);
  const url = `${base}/cosmos/distribution/v1beta1/delegators/${address}/rewards`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`fetchRewards: HTTP ${res.status}`);
      return { rewardsMap: new Map(), totalRewards: "0" };
    }

    const data = await res.json();
    const rewardsMap = new Map<string, string>();

    for (const entry of data.rewards || []) {
      const valAddr: string = entry.validator_address || "";
      let total = 0;
      for (const coin of entry.reward || []) {
        total += parseFloat(coin.amount || "0");
      }
      rewardsMap.set(valAddr, Math.floor(total).toString());
    }

    // Total rewards across all validators
    let totalNum = 0;
    for (const coin of data.total || []) {
      totalNum += parseFloat(coin.amount || "0");
    }
    const totalRewards = Math.floor(totalNum).toString();

    return { rewardsMap, totalRewards };
  } catch (err) {
    console.error("fetchRewards error:", err);
    return { rewardsMap: new Map(), totalRewards: "0" };
  }
}

/**
 * Combined staking info: validators, delegations with rewards merged, total rewards.
 */
export async function fetchStakingInfo(
  address: string,
  network: "testnet" | "mainnet" = "testnet"
): Promise<{
  validators: ValidatorInfo[];
  delegations: DelegationInfo[];
  totalRewards: string;
}> {
  try {
    const validators = await fetchValidators(network);
    const [delegations, rewardsData] = await Promise.all([
      fetchDelegations(address, network, validators),
      fetchRewards(address, network),
    ]);

    // Merge rewards into delegations
    for (const del of delegations) {
      const reward = rewardsData.rewardsMap.get(del.validatorAddress);
      if (reward) {
        del.rewards = reward;
      }
    }

    return {
      validators,
      delegations,
      totalRewards: rewardsData.totalRewards,
    };
  } catch (err) {
    console.error("fetchStakingInfo error:", err);
    return { validators: [], delegations: [], totalRewards: "0" };
  }
}

// ---------------------------------------------------------------------------
// Address History — on-chain first-contact detection
// ---------------------------------------------------------------------------

export interface AddressHistory {
  /** True if at least one prior send from `sender` to `recipient` exists on-chain */
  hasPriorSends: boolean;
  /** Number of prior send txs found (capped at pagination limit) */
  sendCount: number;
}

/**
 * Query the chain for prior transfer events from sender → recipient.
 * Uses the Cosmos tx search endpoint with transfer module events.
 * Returns quickly — we only need to know if count > 0.
 */
export async function checkAddressHistory(
  sender: string,
  recipient: string,
  network: "testnet" | "mainnet" = "testnet"
): Promise<AddressHistory> {
  const base = getRestBase(network);

  // Cosmos SDK tx search with transfer events
  // We only need 1 result to prove prior contact — keep pagination tiny for speed
  const params = new URLSearchParams({
    "events": `transfer.sender='${sender}'`,
    "pagination.limit": "1",
    "order_by": "ORDER_BY_DESC",
  });

  // The Cosmos tx search API requires separate `events` params for AND logic,
  // but URLSearchParams merges them. Use manual URL construction.
  const url = `${base}/cosmos/tx/v1beta1/txs?` +
    `events=transfer.sender%3D%27${sender}%27&` +
    `events=transfer.recipient%3D%27${recipient}%27&` +
    `pagination.limit=1&order_by=ORDER_BY_DESC`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`checkAddressHistory: HTTP ${res.status}`);
      // On network error, fail open — don't block sends, just skip the warning
      return { hasPriorSends: false, sendCount: 0 };
    }
    const data = await res.json();
    const total = parseInt(data.pagination?.total || "0", 10);
    return {
      hasPriorSends: total > 0,
      sendCount: total,
    };
  } catch (err) {
    console.warn("checkAddressHistory error:", err);
    // Fail open — network issues shouldn't block transactions
    return { hasPriorSends: false, sendCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// Recent Sends — on-chain tx history for the send tab
// ---------------------------------------------------------------------------

export interface RecentSend {
  recipient: string;
  amount: string;     // human-readable (e.g. "150.50")
  denom: string;
  txHash: string;
  timestamp: string;  // ISO string or block time
}

/**
 * Fetch the last N unique recipients this wallet has sent to,
 * by querying the Cosmos tx search endpoint for outbound transfers.
 * Returns deduplicated by recipient, most recent first.
 */
export async function fetchRecentSends(
  sender: string,
  network: "testnet" | "mainnet" = "testnet",
  limit: number = 10
): Promise<RecentSend[]> {
  const base = getRestBase(network);
  const denom = getDenom(network);

  // Query recent outbound transfers from this sender
  const url = `${base}/cosmos/tx/v1beta1/txs?` +
    `events=transfer.sender%3D%27${sender}%27&` +
    `pagination.limit=${limit}&order_by=ORDER_BY_DESC`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`fetchRecentSends: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const txs = data.tx_responses || [];

    const seen = new Set<string>();
    const results: RecentSend[] = [];

    for (const tx of txs) {
      // Parse MsgSend from the tx body
      const messages = tx.tx?.body?.messages || [];
      for (const msg of messages) {
        if (msg["@type"] === "/cosmos.bank.v1beta1.MsgSend" && msg.from_address === sender) {
          const recipient = msg.to_address || "";
          if (!recipient || seen.has(recipient)) continue;
          seen.add(recipient);

          // Extract amount
          const coins = msg.amount || [];
          const coin = coins.find((c: any) => c.denom === denom) || coins[0];
          const microAmt = parseInt(coin?.amount || "0", 10);
          const humanAmt = (microAmt / 1_000_000).toFixed(2);

          results.push({
            recipient,
            amount: humanAmt,
            denom: coin?.denom || denom,
            txHash: tx.txhash || "",
            timestamp: tx.timestamp || "",
          });

          if (results.length >= 5) break;
        }
      }
      if (results.length >= 5) break;
    }

    return results;
  } catch (err) {
    console.warn("fetchRecentSends error:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Full Transaction History — sends, stakes, claims for the history panel
// ---------------------------------------------------------------------------

export type TxType = "send" | "receive" | "delegate" | "undelegate" | "claim" | "other";

export interface TxHistoryItem {
  type: TxType;
  txHash: string;
  timestamp: string;
  amount: string;      // human-readable
  denom: string;
  counterparty: string; // recipient for sends, validator for stakes
  success: boolean;
}

/**
 * Fetch recent transactions for a wallet address (all types).
 * Queries the tx search endpoint for any tx involving this address as sender.
 */
export async function fetchTxHistory(
  address: string,
  network: "testnet" | "mainnet" = "testnet",
  limit: number = 10
): Promise<TxHistoryItem[]> {
  const base = getRestBase(network);
  const denom = getDenom(network);

  // Query all txs where this address is the sender (covers sends, stakes, claims)
  const url = `${base}/cosmos/tx/v1beta1/txs?` +
    `events=message.sender%3D%27${address}%27&` +
    `pagination.limit=${limit}&order_by=ORDER_BY_DESC`;

  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const txs = data.tx_responses || [];
    const results: TxHistoryItem[] = [];

    for (const tx of txs) {
      const messages = tx.tx?.body?.messages || [];
      const success = tx.code === 0;
      const timestamp = tx.timestamp || "";
      const txHash = tx.txhash || "";

      for (const msg of messages) {
        const typeUrl = msg["@type"] || "";

        if (typeUrl === "/cosmos.bank.v1beta1.MsgSend") {
          const coins = msg.amount || [];
          const coin = coins.find((c: any) => c.denom === denom) || coins[0];
          const micro = parseInt(coin?.amount || "0", 10);
          const isSend = msg.from_address === address;
          results.push({
            type: isSend ? "send" : "receive",
            txHash,
            timestamp,
            amount: (micro / 1_000_000).toFixed(2),
            denom: coin?.denom || denom,
            counterparty: isSend ? msg.to_address : msg.from_address,
            success,
          });
        } else if (typeUrl === "/cosmos.staking.v1beta1.MsgDelegate") {
          const coin = msg.amount || {};
          const micro = parseInt(coin.amount || "0", 10);
          results.push({
            type: "delegate",
            txHash,
            timestamp,
            amount: (micro / 1_000_000).toFixed(2),
            denom: coin.denom || denom,
            counterparty: msg.validator_address || "",
            success,
          });
        } else if (typeUrl === "/cosmos.staking.v1beta1.MsgUndelegate") {
          const coin = msg.amount || {};
          const micro = parseInt(coin.amount || "0", 10);
          results.push({
            type: "undelegate",
            txHash,
            timestamp,
            amount: (micro / 1_000_000).toFixed(2),
            denom: coin.denom || denom,
            counterparty: msg.validator_address || "",
            success,
          });
        } else if (typeUrl === "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward") {
          results.push({
            type: "claim",
            txHash,
            timestamp,
            amount: "",  // rewards amount is in events, not the message
            denom,
            counterparty: msg.validator_address || "",
            success,
          });
        }
      }

      if (results.length >= limit) break;
    }

    return results.slice(0, limit);
  } catch (err) {
    console.warn("fetchTxHistory error:", err);
    return [];
  }
}
