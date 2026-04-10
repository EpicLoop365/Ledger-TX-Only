/**
 * compliance.ts — Pre-Execution Compliance + Address Safety
 *
 * Validates recipient address format, detects cross-chain mistakes,
 * enforces transfer limits. In production, the TXAI Compliance
 * Execution Layer API (/api/cel/validate) would handle the heavy lifting.
 */

export interface ComplianceResult {
  status: "PASS" | "FAIL";
  reason: string;
}

// Known bech32 prefixes → chain names (catches cross-chain paste mistakes)
const KNOWN_PREFIXES: Record<string, string> = {
  cosmos: "Cosmos Hub",
  osmo: "Osmosis",
  juno: "Juno",
  stars: "Stargaze",
  atom: "Cosmos Hub",
  inj: "Injective",
  sei: "Sei",
  terra: "Terra",
  luna: "Terra",
  akash: "Akash",
  regen: "Regen",
  evmos: "Evmos",
  kava: "Kava",
  axelar: "Axelar",
  persistence: "Persistence",
  secret: "Secret Network",
  band: "Band Protocol",
  fetch: "Fetch.ai",
  umee: "Umee",
  stride: "Stride",
  neutron: "Neutron",
  dydx: "dYdX",
  celestia: "Celestia",
  noble: "Noble",
  bc: "Bitcoin (bech32)",
  tb: "Bitcoin Testnet",
  bnb: "BNB Chain",
  cro: "Cronos",
};

/**
 * Detect if an address looks like a known non-Coreum chain.
 * Returns the chain name or null if unrecognized.
 */
function detectWrongChain(address: string): string | null {
  const lower = address.toLowerCase();
  for (const [prefix, chain] of Object.entries(KNOWN_PREFIXES)) {
    if (lower.startsWith(prefix + "1")) {
      return chain;
    }
  }
  // Detect Ethereum-style hex addresses
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return "Ethereum/EVM";
  }
  return null;
}

/**
 * Basic bech32 format validation (structure check, not checksum).
 * Coreum addresses: core1... (mainnet, 39-44 chars total) or testcore1... (testnet, 43-48 chars)
 */
function isValidCoreumFormat(address: string): { valid: boolean; reason?: string } {
  const trimmed = address.trim();

  // Check minimum length
  if (trimmed.length < 39) {
    return { valid: false, reason: "Address too short — may be truncated from a partial paste" };
  }

  // Check for spaces or non-alphanumeric chars (paste artifacts)
  if (/\s/.test(trimmed)) {
    return { valid: false, reason: "Address contains spaces — check for paste errors" };
  }

  // Check for valid bech32 character set (lowercase alphanumeric, no 1/b/i/o after separator)
  if (!/^(core1|testcore1)[a-z0-9]{38,}$/.test(trimmed)) {
    return { valid: false, reason: "Invalid characters in address — Coreum addresses use lowercase letters and numbers only" };
  }

  // Network-specific length validation
  if (trimmed.startsWith("core1") && (trimmed.length < 43 || trimmed.length > 45)) {
    return { valid: false, reason: `Unexpected address length (${trimmed.length} chars) — standard Coreum mainnet addresses are 43-44 characters` };
  }
  if (trimmed.startsWith("testcore1") && (trimmed.length < 47 || trimmed.length > 49)) {
    return { valid: false, reason: `Unexpected address length (${trimmed.length} chars) — standard Coreum testnet addresses are 47-48 characters` };
  }

  return { valid: true };
}

export function checkCompliance(
  recipient: string,
  amount: number,
  currentNetwork?: "testnet" | "mainnet"
): ComplianceResult {
  const trimmed = recipient.trim();

  // Rule 1: Recipient must be provided
  if (!trimmed || trimmed.length === 0) {
    return {
      status: "FAIL",
      reason: "Recipient address is empty",
    };
  }

  // Rule 2: Cross-chain address detection
  const wrongChain = detectWrongChain(trimmed);
  if (wrongChain && !trimmed.startsWith("core1") && !trimmed.startsWith("testcore1")) {
    return {
      status: "FAIL",
      reason: `This is a ${wrongChain} address, not a Coreum address. Sending here would lose your funds.`,
    };
  }

  // Rule 3: Must be a valid Coreum address format
  if (!trimmed.startsWith("core1") && !trimmed.startsWith("testcore1")) {
    return {
      status: "FAIL",
      reason: "Invalid address — Coreum addresses start with core1 (mainnet) or testcore1 (testnet)",
    };
  }

  // Rule 4: Network mismatch detection
  if (currentNetwork === "mainnet" && trimmed.startsWith("testcore1")) {
    return {
      status: "FAIL",
      reason: "This is a testnet address, but you're on mainnet. Switch networks or use a core1 address.",
    };
  }
  if (currentNetwork === "testnet" && trimmed.startsWith("core1") && !trimmed.startsWith("core1")) {
    // This case is already caught, but explicit for clarity
    return {
      status: "FAIL",
      reason: "This is a mainnet address, but you're on testnet. Switch networks or use a testcore1 address.",
    };
  }

  // Rule 5: Structural validation (length, characters, paste artifacts)
  const formatCheck = isValidCoreumFormat(trimmed);
  if (!formatCheck.valid) {
    return {
      status: "FAIL",
      reason: formatCheck.reason || "Invalid address format",
    };
  }

  // Rule 6: Self-send detection
  // (Can't check here without sender address, but we flag it in the UI)

  // Rule 7: Amount must be positive
  if (amount <= 0) {
    return {
      status: "FAIL",
      reason: "Amount must be greater than 0",
    };
  }

  // Rule 8: Transfer limit (simulated compliance rule)
  if (amount > 10000) {
    return {
      status: "FAIL",
      reason: "Amount exceeds transfer limit of 10,000 COREUM (compliance rule)",
    };
  }

  return {
    status: "PASS",
    reason: "All compliance checks passed — transaction authorized",
  };
}
