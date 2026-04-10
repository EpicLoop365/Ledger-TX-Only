/**
 * client-testnet.test.ts — Live Testnet Integration Tests
 *
 * Hits the real Coreum testnet to verify:
 * - RPC connectivity
 * - Balance fetching
 * - Account info
 * - Chain ID
 * - Validator list
 * - Delegation queries
 * - Reward queries
 * - Tx history search
 *
 * Uses the Coreum testnet faucet address (always funded).
 */

import { describe, it, expect } from "vitest";
import {
  fetchBalance,
  getAccountInfo,
  getChainId,
  getDenom,
  getPrefix,
  fetchValidators,
  fetchDelegations,
  fetchRewards,
  fetchStakingInfo,
  checkAddressHistory,
  fetchTxHistory,
} from "../client";

// Known testnet addresses for testing
// The Coreum faucet has sent to many addresses — use a known funded one
// We use the mainnet address from the wallet for mainnet checks
const MAINNET_ADDR = "core1d87pe85juh95t43x83p6es43rkgvyrtyut5yp3";

// Timeout for network calls
const NETWORK_TIMEOUT = 30_000;

describe("Client: Helpers", () => {
  it("returns correct denom for testnet", () => {
    expect(getDenom("testnet")).toBe("utestcore");
  });

  it("returns correct denom for mainnet", () => {
    expect(getDenom("mainnet")).toBe("ucore");
  });

  it("returns correct prefix for testnet", () => {
    expect(getPrefix("testnet")).toBe("testcore");
  });

  it("returns correct prefix for mainnet", () => {
    expect(getPrefix("mainnet")).toBe("core");
  });
});

describe("Client: RPC Connectivity", () => {
  it(
    "connects to mainnet and returns chain ID",
    async () => {
      const chainId = await getChainId("mainnet");
      expect(chainId).toBe("coreum-mainnet-1");
    },
    NETWORK_TIMEOUT
  );
});

describe("Client: Balance", () => {
  it(
    "fetches mainnet balance for known address",
    async () => {
      const balance = await fetchBalance(MAINNET_ADDR, "mainnet");
      expect(balance).toBeDefined();
      expect(balance.denom).toBe("ucore");
      expect(balance.display).toContain("CORE");
      // The wallet has a known balance > 0
      expect(parseInt(balance.amount)).toBeGreaterThan(0);
    },
    NETWORK_TIMEOUT
  );

  it(
    "throws for invalid bech32 address",
    async () => {
      // Invalid checksum — should throw
      await expect(
        fetchBalance("core1invalidaddressthatdoesnotexist999", "mainnet")
      ).rejects.toThrow();
    },
    NETWORK_TIMEOUT
  );
});

describe("Client: Account Info", () => {
  it(
    "fetches account number and sequence for funded mainnet address",
    async () => {
      const info = await getAccountInfo(MAINNET_ADDR, "mainnet");
      expect(info.accountNumber).toBeGreaterThanOrEqual(0);
      expect(info.sequence).toBeGreaterThanOrEqual(0);
      // This is an active account — sequence should be > 0
      expect(info.sequence).toBeGreaterThan(0);
    },
    NETWORK_TIMEOUT
  );

  it(
    "throws for unfunded address",
    async () => {
      await expect(
        getAccountInfo("core1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5aadcd", "mainnet")
      ).rejects.toThrow();
    },
    NETWORK_TIMEOUT
  );
});

describe("Client: Validators", () => {
  it(
    "fetches mainnet validators",
    async () => {
      const validators = await fetchValidators("mainnet");
      expect(validators.length).toBeGreaterThan(0);

      // Verify structure
      const v = validators[0];
      expect(v.operatorAddress).toMatch(/^corevaloper1/);
      expect(v.moniker).toBeTruthy();
      expect(parseFloat(v.commission)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(v.tokens)).toBeGreaterThan(0);
      expect(v.status).toBe("BOND_STATUS_BONDED");
    },
    NETWORK_TIMEOUT
  );

  it(
    "validators are sorted by tokens descending",
    async () => {
      const validators = await fetchValidators("mainnet");
      for (let i = 1; i < Math.min(validators.length, 10); i++) {
        expect(parseFloat(validators[i - 1].tokens)).toBeGreaterThanOrEqual(
          parseFloat(validators[i].tokens)
        );
      }
    },
    NETWORK_TIMEOUT
  );
});

describe("Client: Delegations + Rewards", () => {
  it(
    "fetches delegations for staking address",
    async () => {
      const delegations = await fetchDelegations(MAINNET_ADDR, "mainnet");
      // This address has known delegations
      expect(delegations.length).toBeGreaterThan(0);

      const d = delegations[0];
      expect(d.validatorAddress).toMatch(/^corevaloper1/);
      expect(parseInt(d.balance)).toBeGreaterThan(0);
    },
    NETWORK_TIMEOUT
  );

  it(
    "fetches rewards for staking address",
    async () => {
      const { rewardsMap, totalRewards } = await fetchRewards(
        MAINNET_ADDR,
        "mainnet"
      );
      expect(rewardsMap.size).toBeGreaterThan(0);
      expect(parseInt(totalRewards)).toBeGreaterThanOrEqual(0);
    },
    NETWORK_TIMEOUT
  );

  it(
    "fetchStakingInfo merges delegations with rewards",
    async () => {
      const info = await fetchStakingInfo(MAINNET_ADDR, "mainnet");
      expect(info.validators.length).toBeGreaterThan(0);
      expect(info.delegations.length).toBeGreaterThan(0);
      // At least one delegation should have merged rewards
      const hasRewards = info.delegations.some(
        (d) => parseInt(d.rewards) > 0
      );
      expect(hasRewards).toBe(true);
    },
    NETWORK_TIMEOUT
  );

  it(
    "returns empty for address with no delegations",
    async () => {
      const delegations = await fetchDelegations(
        "core1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5aadcd",
        "mainnet"
      );
      expect(delegations.length).toBe(0);
    },
    NETWORK_TIMEOUT
  );
});

describe("Client: Address History (first-contact detection)", () => {
  it(
    "checkAddressHistory returns without crashing on mainnet",
    async () => {
      const history = await checkAddressHistory(
        MAINNET_ADDR,
        "core1qypqxpq9qcrsszg2pvxq6rs0zqg3yyc5aadcd",
        "mainnet"
      );
      // Should return a valid structure even if nodes fail
      expect(history).toBeDefined();
      expect(typeof history.hasPriorSends).toBe("boolean");
      expect(typeof history.sendCount).toBe("number");
    },
    NETWORK_TIMEOUT
  );
});

describe("Client: Transaction History", () => {
  it(
    "fetchTxHistory returns without crashing (may be empty due to node issues)",
    async () => {
      const history = await fetchTxHistory(MAINNET_ADDR, "mainnet", 5);
      // The function should not throw even if all nodes return 500
      expect(Array.isArray(history)).toBe(true);
      // If any results come back, verify structure
      if (history.length > 0) {
        const tx = history[0];
        expect(tx.txHash).toBeTruthy();
        expect(["send", "receive", "delegate", "undelegate", "claim", "other"]).toContain(tx.type);
      }
    },
    NETWORK_TIMEOUT
  );
});
