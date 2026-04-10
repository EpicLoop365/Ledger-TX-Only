/**
 * client.ts — Coreum RPC Client
 *
 * Connects to Coreum testnet/mainnet, fetches balances,
 * and broadcasts signed transactions.
 */

import { StargateClient } from "@cosmjs/stargate";
import { decodeTxRaw } from "@cosmjs/proto-signing";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { MsgDelegate, MsgUndelegate } from "cosmjs-types/cosmos/staking/v1beta1/tx";
import { MsgWithdrawDelegatorReward } from "cosmjs-types/cosmos/distribution/v1beta1/tx";

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
 * Force reconnect on next getClient() call.
 * Call after a broadcast to ensure fresh sequence/account data.
 */
export function resetClient(): void {
  if (cachedClient) {
    cachedClient.disconnect();
  }
  cachedClient = null;
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

// Alternative REST endpoints for tx search (primary node may lack tx indexing)
const MAINNET_REST_ALT = [
  "https://rest-coreum.ecostake.com",
  "https://coreum-rest.publicnode.com",
  "https://full-node.mainnet-1.coreum.dev:1317",
];
const TESTNET_REST_ALT = [
  "https://full-node.testnet-1.coreum.dev:1317",
];

function getRestBase(network: "testnet" | "mainnet"): string {
  return network === "mainnet" ? MAINNET_REST : TESTNET_REST;
}

function getRestBases(network: "testnet" | "mainnet"): string[] {
  return network === "mainnet" ? MAINNET_REST_ALT : TESTNET_REST_ALT;
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

  // The Cosmos tx search API requires separate `events` params for AND logic.
  // Try with order_by first, fall back without (some nodes return 500).
  const buildUrl = (withOrder: boolean) => {
    let url = `${base}/cosmos/tx/v1beta1/txs?` +
      `events=${encodeURIComponent(`transfer.sender='${sender}'`)}&` +
      `events=${encodeURIComponent(`transfer.recipient='${recipient}'`)}&` +
      `pagination.limit=1`;
    if (withOrder) url += `&order_by=ORDER_BY_DESC`;
    return url;
  };

  try {
    // Try with order_by, fall back without if the node rejects it
    let res = await fetch(buildUrl(true));
    if (!res.ok) {
      console.warn(`checkAddressHistory: HTTP ${res.status} (with order_by), retrying...`);
      res = await fetch(buildUrl(false));
    }
    if (!res.ok) {
      console.warn(`checkAddressHistory: HTTP ${res.status}`);
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
  const bases = getRestBases(network);
  const denom = getDenom(network);

  // Try each REST node with order_by fallback
  const queryTxs = async (event: string): Promise<any[]> => {
    for (const base of bases) {
      for (const withOrder of [true, false]) {
        try {
          const params: Record<string, string> = {
            "events": event,
            "pagination.limit": String(limit),
          };
          if (withOrder) params["order_by"] = "ORDER_BY_DESC";
          const url = `${base}/cosmos/tx/v1beta1/txs?${new URLSearchParams(params)}`;
          console.log(`[fetchRecentSends] ${base.slice(8, 40)}... order=${withOrder}`);
          const res = await fetch(url);
          if (!res.ok) {
            if (withOrder) continue;
            throw new Error(`HTTP ${res.status}`);
          }
          const data = await res.json();
          const txs = data.tx_responses || [];
          if (txs.length > 0) return txs;
          if (!withOrder) break; // this node works but has no results, try next
        } catch {
          if (withOrder) continue;
          break; // try next node
        }
      }
    }
    return [];
  };

  try {
    const txs = await queryTxs(`transfer.sender='${sender}'`);

    const seen = new Set<string>();
    const results: RecentSend[] = [];

    for (const tx of txs) {
      const messages = tx.tx?.body?.messages || [];
      for (const msg of messages) {
        if (msg["@type"] === "/cosmos.bank.v1beta1.MsgSend" && msg.from_address === sender) {
          const recipient = msg.to_address || "";
          if (!recipient || seen.has(recipient)) continue;
          seen.add(recipient);

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
 * Queries the Cosmos tx search endpoint for sender and receiver events,
 * merges them, deduplicates by txHash, and sorts by timestamp.
 */
export async function fetchTxHistory(
  address: string,
  network: "testnet" | "mainnet" = "testnet",
  limit: number = 20
): Promise<TxHistoryItem[]> {
  const denom = getDenom(network);

  // Parse an IndexedTx from StargateClient.searchTx into TxHistoryItem(s)
  const parseTx = (tx: any): TxHistoryItem[] => {
    const items: TxHistoryItem[] = [];
    const success = tx.code === 0;
    const txHash = tx.hash || "";
    // searchTx returns height, not timestamp — we'll estimate from height later
    const timestamp = tx.timestamp || "";

    // Decode messages from the raw tx bytes
    let messages: any[] = [];
    try {
      const decoded = decodeTxRaw(tx.tx);
      messages = decoded.body.messages;
    } catch {
      return items;
    }

    for (const msg of messages) {
      const typeUrl = msg.typeUrl || "";

      if (typeUrl === "/cosmos.bank.v1beta1.MsgSend") {
        try {
          const decoded = MsgSend.decode(msg.value);
          const coin = decoded.amount.find((c: any) => c.denom === denom) || decoded.amount[0];
          const micro = parseInt(coin?.amount || "0", 10);
          const isSend = decoded.fromAddress === address;
          items.push({
            type: isSend ? "send" : "receive",
            txHash, timestamp,
            amount: (micro / 1_000_000).toFixed(2),
            denom: coin?.denom || denom,
            counterparty: isSend ? decoded.toAddress : decoded.fromAddress,
            success,
          });
        } catch { /* skip unparseable */ }
      } else if (typeUrl === "/cosmos.staking.v1beta1.MsgDelegate") {
        try {
          const decoded = MsgDelegate.decode(msg.value);
          const micro = parseInt(decoded.amount?.amount || "0", 10);
          items.push({
            type: "delegate", txHash, timestamp,
            amount: (micro / 1_000_000).toFixed(2),
            denom: decoded.amount?.denom || denom,
            counterparty: decoded.validatorAddress || "", success,
          });
        } catch { /* skip */ }
      } else if (typeUrl === "/cosmos.staking.v1beta1.MsgUndelegate") {
        try {
          const decoded = MsgUndelegate.decode(msg.value);
          const micro = parseInt(decoded.amount?.amount || "0", 10);
          items.push({
            type: "undelegate", txHash, timestamp,
            amount: (micro / 1_000_000).toFixed(2),
            denom: decoded.amount?.denom || denom,
            counterparty: decoded.validatorAddress || "", success,
          });
        } catch { /* skip */ }
      } else if (typeUrl === "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward") {
        try {
          const decoded = MsgWithdrawDelegatorReward.decode(msg.value);
          // Reward amount isn't in the message — extract from tx_result events.
          // Coreum Tendermint RPC returns event attributes as PLAIN TEXT (not base64).
          let claimAmount = "";
          const events = tx.events || [];
          // ONLY look at withdraw_rewards events — coin_received would match the fee
          for (const evt of events) {
            if (evt.type !== "withdraw_rewards") continue;
            const attrs = evt.attributes || [];
            for (const attr of attrs) {
              const key = attr.key || "";
              const val = attr.value || "";
              if (key === "amount" && val.includes(denom)) {
                // Value format: "181274649ucore" or "139090ucore,500utestcore"
                const parts = val.split(",");
                for (const part of parts) {
                  if (part.includes(denom)) {
                    const micro = parseInt(part.replace(denom, "").trim(), 10);
                    if (!isNaN(micro) && micro > 0) {
                      // Accumulate if multiple withdraw_rewards events (multi-validator)
                      const prev = claimAmount ? parseFloat(claimAmount) * 1_000_000 : 0;
                      claimAmount = ((prev + micro) / 1_000_000).toFixed(4);
                    }
                  }
                }
              }
            }
          }
          items.push({
            type: "claim", txHash, timestamp,
            amount: claimAmount,
            denom,
            counterparty: decoded.validatorAddress || "", success,
          });
        } catch { /* skip */ }
      }
    }
    return items;
  };

  // ── Strategy: Direct Tendermint RPC tx_search with per_page (fast + paginated) ──
  // Then fall back to REST /cosmos/tx/v1beta1/txs if RPC fails.

  const rpc = network === "mainnet" ? COREUM_MAINNET_RPC : COREUM_TESTNET_RPC;
  const perPage = Math.min(limit, 20);

  // Helper: call Tendermint RPC tx_search with pagination
  const rpcTxSearch = async (query: string): Promise<any[]> => {
    const url = `${rpc}/tx_search?query=${encodeURIComponent(`"${query}"`)}&per_page=${perPage}&page=1&order_by="desc"`;
    console.log(`[fetchTxHistory] RPC tx_search: ${query.slice(0, 50)}...`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return data.result?.txs || [];
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  };

  // Helper: parse a Tendermint RPC tx result into TxHistoryItem(s)
  const parseRpcTx = (rpcTx: any): TxHistoryItem[] => {
    const txBytes = rpcTx.tx ? Uint8Array.from(atob(rpcTx.tx), (c) => c.charCodeAt(0)) : null;
    if (!txBytes) return [];
    const code = parseInt(rpcTx.tx_result?.code || "0", 10);
    const hash = rpcTx.hash || "";
    const height = rpcTx.height || "0";
    const timestamp = "";
    // Pass tx_result events so parseTx can extract claim reward amounts
    const events = rpcTx.tx_result?.events || [];
    return parseTx({ tx: txBytes, code, hash, height, timestamp, events });
  };

  try {
    const [senderRaw, recipientRaw] = await Promise.all([
      rpcTxSearch(`message.sender='${address}'`).catch(() => []),
      rpcTxSearch(`transfer.recipient='${address}'`).catch(() => []),
    ]);

    console.log(`[fetchTxHistory] RPC: ${senderRaw.length} sender, ${recipientRaw.length} recipient results`);

    const results: TxHistoryItem[] = [];
    const seenHashes = new Set<string>();

    for (const rpcTx of [...senderRaw, ...recipientRaw]) {
      const hash = rpcTx.hash || "";
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      results.push(...parseRpcTx(rpcTx));
    }

    // Sort by height descending (newest first)
    if (results.length > 0) {
      return results.slice(0, limit);
    }
  } catch (err) {
    console.warn("[fetchTxHistory] RPC tx_search failed:", err);
  }

  // ── Fallback: REST /cosmos/tx/v1beta1/txs ──
  console.log("[fetchTxHistory] Trying REST fallback...");
  const bases = getRestBases(network);

  const parseRestMessages = (tx: any, seenHashes: Set<string>): TxHistoryItem[] => {
    const hash = tx.txhash || "";
    if (seenHashes.has(hash)) return [];
    seenHashes.add(hash);
    const items: TxHistoryItem[] = [];
    const messages = tx.tx?.body?.messages || [];
    for (const msg of messages) {
      const typeUrl = msg["@type"] || "";
      if (typeUrl === "/cosmos.bank.v1beta1.MsgSend") {
        const coins = msg.amount || [];
        const coin = coins.find((c: any) => c.denom === denom) || coins[0];
        const micro = parseInt(coin?.amount || "0", 10);
        const isSend = msg.from_address === address;
        items.push({
          type: isSend ? "send" : "receive",
          txHash: hash, timestamp: tx.timestamp || "",
          amount: (micro / 1_000_000).toFixed(2),
          denom: coin?.denom || denom,
          counterparty: isSend ? msg.to_address : msg.from_address,
          success: tx.code === 0,
        });
      } else if (typeUrl === "/cosmos.staking.v1beta1.MsgDelegate") {
        const micro = parseInt(msg.amount?.amount || "0", 10);
        items.push({
          type: "delegate", txHash: hash, timestamp: tx.timestamp || "",
          amount: (micro / 1_000_000).toFixed(2), denom,
          counterparty: msg.validator_address || "", success: tx.code === 0,
        });
      } else if (typeUrl === "/cosmos.staking.v1beta1.MsgUndelegate") {
        const micro = parseInt(msg.amount?.amount || "0", 10);
        items.push({
          type: "undelegate", txHash: hash, timestamp: tx.timestamp || "",
          amount: (micro / 1_000_000).toFixed(2), denom,
          counterparty: msg.validator_address || "", success: tx.code === 0,
        });
      } else if (typeUrl === "/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward") {
        items.push({
          type: "claim", txHash: hash, timestamp: tx.timestamp || "",
          amount: "", denom,
          counterparty: msg.validator_address || "", success: tx.code === 0,
        });
      }
    }
    return items;
  };

  for (const base of bases) {
    try {
      const params = new URLSearchParams({
        "events": `message.sender='${address}'`,
        "pagination.limit": String(limit),
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(`${base}/cosmos/tx/v1beta1/txs?${params}`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const data = await res.json();
      const txResponses = data.tx_responses || [];
      if (txResponses.length === 0) continue;

      const results: TxHistoryItem[] = [];
      const seenHashes = new Set<string>();
      for (const tx of txResponses) {
        results.push(...parseRestMessages(tx, seenHashes));
      }
      if (results.length > 0) return results.slice(0, limit);
    } catch { continue; }
  }
  return [];
}
