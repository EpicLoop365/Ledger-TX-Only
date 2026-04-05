import { useState, useCallback } from "react";
import { connectLedger, signWithLedger, disconnectLedger, type LedgerConnection } from "./ledger";
import { fetchBalance, getAccountInfo, getChainId, broadcastTx, getDenom, getPrefix, type BalanceInfo } from "./client";
import { buildAminoSignDoc, assembleTxBytes, toMicroAmount } from "./txBuilder";
import { checkCompliance, type ComplianceResult } from "./compliance";

type Status = { type: "pass" | "fail" | "info" | "warn"; message: string } | null;
type Network = "testnet" | "mainnet";

function App() {
  // Network state
  const [network, setNetwork] = useState<Network>("mainnet");

  // Connection state
  const [ledger, setLedger] = useState<LedgerConnection | null>(null);
  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [connecting, setConnecting] = useState(false);

  // Transaction state
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [status, setStatus] = useState<Status>(null);
  const [complianceResult, setComplianceResult] = useState<ComplianceResult | null>(null);
  const [signing, setSigning] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);

  // ── Connect Ledger ──
  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setStatus({ type: "info", message: "Requesting Ledger connection... Open the Cosmos app on your device." });

    try {
      const prefix = getPrefix(network);
      const connection = await connectLedger(prefix);
      setLedger(connection);

      setStatus({ type: "info", message: "Fetching balance..." });
      const bal = await fetchBalance(connection.address, network);
      setBalance(bal);

      setStatus({ type: "pass", message: "Ledger connected successfully" });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("denied") || msg.includes("NotAllowedError")) {
        setStatus({ type: "fail", message: "USB access denied. Click Connect and select your Ledger device." });
      } else if (msg.includes("No device selected")) {
        setStatus({ type: "fail", message: "No Ledger device selected. Please try again." });
      } else if (msg.includes("CLA_NOT_SUPPORTED") || msg.includes("0x6e00")) {
        setStatus({ type: "fail", message: "Wrong app open on Ledger. Please open the Cosmos app." });
      } else {
        setStatus({ type: "fail", message: `Connection failed: ${msg}` });
      }
    }

    setConnecting(false);
  }, [network]);

  // ── Switch Network ──
  const handleNetworkSwitch = useCallback(async (newNetwork: Network) => {
    if (newNetwork === network) return;

    // Disconnect if connected (address prefix changes between networks)
    if (ledger) {
      await disconnectLedger(ledger.transport);
      setLedger(null);
      setBalance(null);
      setComplianceResult(null);
      setTxHash(null);
    }

    setNetwork(newNetwork);
    setStatus({ type: "info", message: `Switched to ${newNetwork}. Connect your Ledger to continue.` });
  }, [network, ledger]);

  // ── Disconnect ──
  const handleDisconnect = useCallback(async () => {
    if (ledger) {
      await disconnectLedger(ledger.transport);
      setLedger(null);
      setBalance(null);
      setStatus(null);
      setComplianceResult(null);
      setTxHash(null);
    }
  }, [ledger]);

  // ── Refresh Balance ──
  const handleRefreshBalance = useCallback(async () => {
    if (!ledger) return;
    try {
      const bal = await fetchBalance(ledger.address, network);
      setBalance(bal);
    } catch (err) {
      setStatus({ type: "fail", message: `Failed to fetch balance: ${(err as Error).message}` });
    }
  }, [ledger, network]);

  // ── Run Compliance Check ──
  const handleCompliance = useCallback(() => {
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum)) {
      setComplianceResult({ status: "FAIL", reason: "Invalid amount" });
      return;
    }

    const result = checkCompliance(recipient, amountNum);
    setComplianceResult(result);
    setTxHash(null);

    if (result.status === "PASS") {
      setStatus({ type: "pass", message: "Compliance check passed. Ready to sign." });
    } else {
      setStatus({ type: "fail", message: `Compliance check failed: ${result.reason}` });
    }
  }, [recipient, amount]);

  // ── Sign & Send ──
  const handleSignAndSend = useCallback(async () => {
    if (!ledger || !complianceResult || complianceResult.status !== "PASS") return;

    setSigning(true);
    setStatus({ type: "info", message: "Preparing transaction..." });

    try {
      const amountNum = parseFloat(amount);
      const microAmount = toMicroAmount(amountNum);
      const denom = getDenom(network);

      // Get account info
      setStatus({ type: "info", message: "Fetching account info..." });
      const { accountNumber, sequence } = await getAccountInfo(ledger.address, network);
      const chainId = await getChainId(network);

      // Build sign doc
      const { signDoc, signDocString } = buildAminoSignDoc({
        fromAddress: ledger.address,
        toAddress: recipient.trim(),
        amount: microAmount,
        denom,
        chainId,
        accountNumber,
        sequence,
        memo: "Sent via Coreum Secure Execution",
      });

      // Sign with Ledger
      setStatus({ type: "warn", message: "Please confirm the transaction on your Ledger device..." });
      const signature = await signWithLedger(ledger.app, signDocString);

      // Assemble and broadcast
      setStatus({ type: "info", message: "Broadcasting transaction..." });
      const txBytes = assembleTxBytes(signDoc, signature, ledger.publicKey);
      const result = await broadcastTx(txBytes, network);

      if (result.success) {
        setTxHash(result.txHash);
        setStatus({ type: "pass", message: "Transaction broadcast successfully!" });

        // Refresh balance
        setTimeout(() => handleRefreshBalance(), 3000);
      } else {
        setStatus({ type: "fail", message: `Broadcast failed: ${result.error}` });
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("rejected") || msg.includes("denied") || msg.includes("0x6985")) {
        setStatus({ type: "fail", message: "Transaction rejected on Ledger device" });
      } else {
        setStatus({ type: "fail", message: `Transaction failed: ${msg}` });
      }
    }

    setSigning(false);
  }, [ledger, complianceResult, recipient, amount, network, handleRefreshBalance]);

  const explorerBase = network === "mainnet"
    ? "https://explorer.coreum.com/coreum/transactions"
    : "https://explorer.testnet-1.coreum.dev/coreum/transactions";

  return (
    <>
      <div className="header">
        <h1>Coreum Secure Execution</h1>
        <div className="subtitle">Ledger-secured &bull; Pre-execution compliance</div>
      </div>

      {/* ── Network Toggle ── */}
      <div className="card">
        <div className="section-label">Network</div>
        <div className="network-toggle">
          <button
            className={`toggle-btn ${network === "testnet" ? "active" : ""}`}
            onClick={() => handleNetworkSwitch("testnet")}
            disabled={connecting || signing}
          >
            Testnet
          </button>
          <button
            className={`toggle-btn ${network === "mainnet" ? "active" : ""}`}
            onClick={() => handleNetworkSwitch("mainnet")}
            disabled={connecting || signing}
          >
            Mainnet
          </button>
        </div>
      </div>

      {/* ── Connect Card ── */}
      <div className="card">
        <div className="section-label">Ledger Device</div>

        {!ledger ? (
          <button
            className="btn btn-primary"
            onClick={handleConnect}
            disabled={connecting}
          >
            {connecting ? (
              <><span className="spinner" /> Connecting...</>
            ) : (
              "Connect Ledger"
            )}
          </button>
        ) : (
          <>
            <div className="wallet-info">
              <div className="wallet-row">
                <span className="label">Status</span>
                <span className="value" style={{ color: "var(--green)" }}>Connected</span>
              </div>
              <div className="wallet-row">
                <span className="label">Address</span>
                <span className="value">{ledger.address}</span>
              </div>
              <div className="wallet-row">
                <span className="label">Balance</span>
                <span className="value" style={{ color: "var(--green)" }}>
                  {balance?.display || "Loading..."}
                </span>
              </div>
              <div className="wallet-row">
                <span className="label">Network</span>
                <span className="value">{network}</span>
              </div>
            </div>
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button className="btn btn-outline" onClick={handleRefreshBalance} style={{ flex: 1 }}>
                Refresh
              </button>
              <button className="btn btn-outline" onClick={handleDisconnect} style={{ flex: 1, borderColor: "var(--red)", color: "var(--red)" }}>
                Disconnect
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── Transaction Card ── */}
      {ledger && (
        <div className="card">
          <div className="section-label">Send Transaction</div>

          <div className="input-group">
            <label>Recipient Address</label>
            <input
              type="text"
              placeholder={`${getPrefix(network)}1...`}
              value={recipient}
              onChange={(e) => {
                setRecipient(e.target.value);
                setComplianceResult(null);
                setTxHash(null);
              }}
            />
          </div>

          <div className="input-group">
            <label>Amount (CORE)</label>
            <input
              type="number"
              placeholder="0.00"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setComplianceResult(null);
                setTxHash(null);
              }}
            />
          </div>

          <button
            className="btn btn-accent"
            onClick={handleCompliance}
            disabled={!recipient || !amount || signing}
            style={{ marginBottom: 8 }}
          >
            Run Compliance Check
          </button>

          {/* Compliance Result */}
          {complianceResult && (
            <div className={`status ${complianceResult.status === "PASS" ? "pass" : "fail"}`}>
              <strong>{complianceResult.status}</strong> &mdash; {complianceResult.reason}
            </div>
          )}

          {/* Sign & Send */}
          {complianceResult?.status === "PASS" && !txHash && (
            <>
              <div className="divider" />
              <button
                className="btn btn-primary"
                onClick={handleSignAndSend}
                disabled={signing}
              >
                {signing ? (
                  <><span className="spinner" /> Signing...</>
                ) : (
                  "Sign & Send with Ledger"
                )}
              </button>
            </>
          )}

          {/* TX Result */}
          {txHash && (
            <div className="tx-result">
              <div style={{ color: "var(--green)", fontWeight: 700, marginBottom: 8 }}>
                Transaction Successful
              </div>
              <div>
                <span style={{ color: "var(--muted)" }}>TX Hash:</span>{" "}
                <a href={`${explorerBase}/${txHash}`} target="_blank" rel="noopener noreferrer">
                  {txHash.slice(0, 16)}...{txHash.slice(-8)}
                </a>
              </div>
              <div>
                <span style={{ color: "var(--muted)" }}>Amount:</span> {amount} CORE
              </div>
              <div>
                <span style={{ color: "var(--muted)" }}>To:</span> {recipient.slice(0, 20)}...
              </div>
            </div>
          )}
        </div>
      )}

      {/* Status Message */}
      {status && !complianceResult && (
        <div className={`status ${status.type}`}>
          {status.message}
        </div>
      )}

      {/* Footer */}
      <div className="footer">
        Powered by <a href="https://solomentelabs.com" target="_blank">TXAI</a> &bull; Built on Coreum
      </div>
    </>
  );
}

export default App;
