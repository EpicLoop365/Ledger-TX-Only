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
