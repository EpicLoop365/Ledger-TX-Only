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
