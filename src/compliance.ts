/**
 * compliance.ts — Simulated Pre-Execution Compliance Check
 *
 * For demo purposes. In production, this would call the TXAI
 * Compliance Execution Layer API (/api/cel/validate).
 */

export interface ComplianceResult {
  status: "PASS" | "FAIL";
  reason: string;
}

export function checkCompliance(
  recipient: string,
  amount: number
): ComplianceResult {
  // Rule 1: Recipient must be provided
  if (!recipient || recipient.trim().length === 0) {
    return {
      status: "FAIL",
      reason: "Recipient address is empty",
    };
  }

  // Rule 2: Recipient must be a valid Coreum address
  if (!recipient.startsWith("core1") && !recipient.startsWith("testcore1")) {
    return {
      status: "FAIL",
      reason: "Invalid Coreum address — must start with core1 or testcore1",
    };
  }

  // Rule 3: Amount must be positive
  if (amount <= 0) {
    return {
      status: "FAIL",
      reason: "Amount must be greater than 0",
    };
  }

  // Rule 4: Transfer limit (simulated compliance rule)
  if (amount > 1000) {
    return {
      status: "FAIL",
      reason: "Amount exceeds transfer limit of 1,000 COREUM (compliance rule)",
    };
  }

  return {
    status: "PASS",
    reason: "All compliance checks passed — transaction authorized",
  };
}
