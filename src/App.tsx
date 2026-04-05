import { useState, useCallback, useEffect } from "react";
import { connectLedger, signWithLedger, disconnectLedger, type LedgerConnection } from "./ledger";
import { fetchBalance, getAccountInfo, getChainId, broadcastTx, getDenom, getPrefix, type BalanceInfo } from "./client";
import { buildAminoSignDoc, assembleTxBytes, toMicroAmount } from "./txBuilder";
import { checkCompliance, type ComplianceResult } from "./compliance";

type Status = { type: "pass" | "fail" | "info" | "warn"; message: string } | null;
type Network = "testnet" | "mainnet";

// Anti-phishing profile stored in localStorage
interface UserProfile {
  name: string;
  secretPhrase: string;
  accentColor: string;
  lastLogin: string;
  lastAddress?: string;
}

const STORAGE_KEY = "txwallet_profile";
const ACCENT_COLORS = [
  { name: "Indigo", value: "#818cf8" },
  { name: "Emerald", value: "#34d399" },
  { name: "Amber", value: "#fbbf24" },
  { name: "Rose", value: "#fb7185" },
  { name: "Cyan", value: "#22d3ee" },
  { name: "Orange", value: "#fb923c" },
  { name: "Violet", value: "#a78bfa" },
  { name: "Lime", value: "#a3e635" },
];

function loadProfile(): UserProfile | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveProfile(profile: UserProfile) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
}

const VALID_DOMAIN = "ledger.solomentelabs.com";

function App() {
  // Anti-phishing state
  const [profile, setProfile] = useState<UserProfile | null>(loadProfile);
  const [setupStep, setSetupStep] = useState(0);
  const [setupName, setSetupName] = useState("");
  const [setupPhrase, setSetupPhrase] = useState("");
  const [setupColor, setSetupColor] = useState(ACCENT_COLORS[0].value);

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

  // Transaction agreement
  const [showAgreement, setShowAgreement] = useState(false);
  const [agreementChecked, setAgreementChecked] = useState(false);

  // Debug state
  const [debugLog, setDebugLog] = useState<string[]>([]);
  const [usbDevices, setUsbDevices] = useState<string>("checking...");
  const [showDebug, setShowDebug] = useState(false);

  // Domain check
  const currentDomain = window.location.hostname;
  const isDomainValid = currentDomain === VALID_DOMAIN || currentDomain === "localhost" || currentDomain === "127.0.0.1";

  const log = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setDebugLog((prev) => [`[${ts}] ${msg}`, ...prev].slice(0, 30));
  }, []);

  // Apply accent color as CSS variable
  useEffect(() => {
    if (profile) {
      document.documentElement.style.setProperty("--user-accent", profile.accentColor);
    }
  }, [profile]);

  // Poll USB devices
  useEffect(() => {
    const check = async () => {
      try {
        const usb = (navigator as any).usb;
        if (!usb) { setUsbDevices("WebUSB not supported"); return; }
        const devices = await usb.getDevices();
        if (devices.length === 0) {
          setUsbDevices("No paired devices");
        } else {
          setUsbDevices(devices.map((d: any) =>
            `${d.productName || "Unknown"} (vendor:0x${d.vendorId.toString(16)}) ${d.opened ? "OPEN" : "closed"}`
          ).join(", "));
        }
      } catch (e: any) {
        setUsbDevices(`Error: ${e.message}`);
      }
    };
    check();
    const interval = setInterval(check, 2000);
    return () => clearInterval(interval);
  }, []);

  // ── Setup Wizard ──
  const handleSetupComplete = useCallback(() => {
    const newProfile: UserProfile = {
      name: setupName.trim(),
      secretPhrase: setupPhrase.trim(),
      accentColor: setupColor,
      lastLogin: new Date().toISOString(),
    };
    saveProfile(newProfile);
    setProfile(newProfile);
  }, [setupName, setupPhrase, setupColor]);

  // ── Connect Ledger ──
  const handleConnect = useCallback(async () => {
    setConnecting(true);
    log("Connect clicked — requesting USB...");
    setStatus({ type: "info", message: "Requesting Ledger connection... Open the Cosmos app on your device." });

    try {
      const prefix = getPrefix(network);
      log(`Creating transport (prefix: ${prefix})...`);
      const connection = await connectLedger(prefix);
      log(`Connected: ${connection.address}`);
      setLedger(connection);

      log("Fetching balance...");
      setStatus({ type: "info", message: "Fetching balance..." });
      const bal = await fetchBalance(connection.address, network);
      log(`Balance: ${bal.display}`);
      setBalance(bal);

      // Update profile with last address and login time
      if (profile) {
        const updated = { ...profile, lastLogin: new Date().toISOString(), lastAddress: connection.address };
        saveProfile(updated);
        setProfile(updated);
      }

      setStatus({ type: "pass", message: "Ledger connected successfully" });
    } catch (err) {
      const msg = (err as Error).message;
      log(`ERROR: ${msg}`);
      if (msg.includes("denied") || msg.includes("NotAllowedError")) {
        setStatus({ type: "fail", message: "USB access denied. Click Connect and select your Ledger device." });
      } else if (msg.includes("No device selected")) {
        setStatus({ type: "fail", message: "No Ledger device selected. Please try again." });
      } else if (msg.includes("CLA_NOT_SUPPORTED") || msg.includes("0x6e00")) {
        setStatus({ type: "fail", message: "Wrong app open on Ledger. Please open the Cosmos app." });
      } else if (msg.includes("claimInterface")) {
        setStatus({ type: "fail", message: "USB interface locked. Click 'Release USB' below, then try again." });
      } else {
        setStatus({ type: "fail", message: `Connection failed: ${msg}` });
      }
    }

    setConnecting(false);
  }, [network, profile, log]);

  // ── Release USB ──
  const handleReleaseUSB = useCallback(async () => {
    log("Release USB clicked...");
    try {
      const usb = (navigator as any).usb;
      if (!usb) {
        log("WebUSB not available");
        setStatus({ type: "info", message: "WebUSB not supported. Unplug and replug your Ledger." });
        return;
      }
      const devices = await usb.getDevices();
      log(`Found ${devices.length} paired device(s)`);
      for (const device of devices) {
        try {
          if (device.opened) {
            log(`Closing ${device.productName || "device"}...`);
            await device.close();
            log("Device closed");
          } else {
            log(`${device.productName || "device"} already closed`);
          }
        } catch (e: any) {
          log(`Close error: ${e.message}`);
        }
      }
      setStatus({ type: "pass", message: "USB released. Try Connect Ledger again." });
    } catch (e: any) {
      log(`Release error: ${e.message}`);
      setStatus({ type: "info", message: "Unplug and replug your Ledger, then try Connect." });
    }
  }, [log]);

  // ── Switch Network ──
  const handleNetworkSwitch = useCallback(async (newNetwork: Network) => {
    if (newNetwork === network) return;
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
      setShowAgreement(false);
      setAgreementChecked(false);
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
    setShowAgreement(false);
    setAgreementChecked(false);

    if (result.status === "PASS") {
      setStatus({ type: "pass", message: "Compliance check passed." });
      setShowAgreement(true);
    } else {
      setStatus({ type: "fail", message: `Compliance check failed: ${result.reason}` });
    }
  }, [recipient, amount]);

  // ── Sign & Send ──
  const handleSignAndSend = useCallback(async () => {
    if (!ledger || !complianceResult || complianceResult.status !== "PASS" || !agreementChecked) return;

    setSigning(true);
    setStatus({ type: "info", message: "Preparing transaction..." });

    try {
      const amountNum = parseFloat(amount);
      const microAmount = toMicroAmount(amountNum);
      const denom = getDenom(network);

      setStatus({ type: "info", message: "Fetching account info..." });
      const { accountNumber, sequence } = await getAccountInfo(ledger.address, network);
      const chainId = await getChainId(network);

      console.log("[TX] Account:", accountNumber, "Sequence:", sequence, "ChainID:", chainId);
      console.log("[TX] PublicKey length:", ledger.publicKey.length, "hex:", Array.from(ledger.publicKey).map(b => b.toString(16).padStart(2, "0")).join(""));

      const { signDoc, signDocString } = buildAminoSignDoc({
        fromAddress: ledger.address,
        toAddress: recipient.trim(),
        amount: microAmount,
        denom,
        chainId,
        accountNumber,
        sequence,
        memo: "Sent via TX Web Wallet",
      });

      setStatus({ type: "warn", message: "Please confirm the transaction on your Ledger device..." });
      console.log("[TX] SignDoc:", signDocString);
      console.log("[TX] Requesting Ledger signature...");
      const signature = await signWithLedger(ledger.app, signDocString, ledger.prefix);
      console.log("[TX] Signature received, assembling tx bytes...");

      setStatus({ type: "info", message: "Broadcasting transaction..." });
      try {
        const txBytes = assembleTxBytes(signDoc, signature, ledger.publicKey);
        console.log("[TX] Tx bytes assembled:", txBytes.length, "bytes");

        const result = await broadcastTx(txBytes, network);
        console.log("[TX] Broadcast result:", JSON.stringify(result));

        if (result.success) {
          setTxHash(result.txHash);
          setStatus({ type: "pass", message: "Transaction broadcast successfully!" });
          setShowAgreement(false);
          setTimeout(() => handleRefreshBalance(), 3000);
        } else {
          setStatus({ type: "fail", message: `Broadcast failed: ${result.error}` });
        }
      } catch (assembleErr: any) {
        console.error("[TX] Assembly/broadcast error:", assembleErr);
        setStatus({ type: "fail", message: `TX assembly failed: ${assembleErr.message}` });
      }
    } catch (err: any) {
      console.error("[TX] Sign error:", err);
      const msg = err.message || String(err);
      if (msg.includes("rejected") || msg.includes("denied") || msg.includes("0x6985")) {
        setStatus({ type: "fail", message: "Transaction rejected on Ledger device" });
      } else {
        setStatus({ type: "fail", message: `Transaction failed: ${msg}` });
      }
    }

    setSigning(false);
  }, [ledger, complianceResult, recipient, amount, network, agreementChecked, handleRefreshBalance]);

  // Reset profile
  const handleResetProfile = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setProfile(null);
    setSetupStep(0);
    setSetupName("");
    setSetupPhrase("");
    setSetupColor(ACCENT_COLORS[0].value);
  }, []);

  const explorerBase = "https://solomentelabs.com/explorer.html";

  const formatLastLogin = (iso: string) => {
    try {
      return new Date(iso).toLocaleString();
    } catch { return "Unknown"; }
  };

  // ── SETUP WIZARD ──
  if (!profile) {
    return (
      <div className="setup-container">
        <div className="setup-card">
          <div className="setup-icon">🛡️</div>
          <h1 className="setup-title">TX Web Wallet</h1>
          <p className="setup-subtitle">Ledger-only. TX-only. Nothing between.</p>

          {setupStep === 0 && (
            <>
              <p className="setup-desc">
                Your personal details are stored locally on this device. Every time you return,
                you'll see them — confirming this is the real site. A phishing clone won't have them.
              </p>
              <button className="btn btn-primary" onClick={() => setSetupStep(1)}>
                Get Started
              </button>
            </>
          )}

          {setupStep === 1 && (
            <>
              <div className="setup-step-label">Step 1 of 3 — Your Name</div>
              <div className="input-group">
                <label>What should we call you?</label>
                <input
                  type="text"
                  placeholder="Enter your name"
                  value={setupName}
                  onChange={(e) => setSetupName(e.target.value)}
                  autoFocus
                />
              </div>
              <button
                className="btn btn-primary"
                onClick={() => setSetupStep(2)}
                disabled={!setupName.trim()}
              >
                Next
              </button>
            </>
          )}

          {setupStep === 2 && (
            <>
              <div className="setup-step-label">Step 2 of 3 — Secret Phrase</div>
              <div className="input-group">
                <label>Enter a phrase only you would know</label>
                <input
                  type="text"
                  placeholder="e.g. my dog ate the blockchain"
                  value={setupPhrase}
                  onChange={(e) => setSetupPhrase(e.target.value)}
                  autoFocus
                />
              </div>
              <p className="setup-hint">
                This phrase will be displayed every visit. If you don't see it, you're on a fake site.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-outline" onClick={() => setSetupStep(1)} style={{ flex: 1 }}>
                  Back
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => setSetupStep(3)}
                  disabled={!setupPhrase.trim()}
                  style={{ flex: 1 }}
                >
                  Next
                </button>
              </div>
            </>
          )}

          {setupStep === 3 && (
            <>
              <div className="setup-step-label">Step 3 of 3 — Your Color</div>
              <p className="setup-hint">Pick an accent color. This will be your visual signature.</p>
              <div className="color-grid">
                {ACCENT_COLORS.map((c) => (
                  <button
                    key={c.value}
                    className={`color-swatch ${setupColor === c.value ? "selected" : ""}`}
                    style={{ backgroundColor: c.value }}
                    onClick={() => setSetupColor(c.value)}
                    title={c.name}
                  />
                ))}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
                <button className="btn btn-outline" onClick={() => setSetupStep(2)} style={{ flex: 1 }}>
                  Back
                </button>
                <button className="btn btn-primary" onClick={handleSetupComplete} style={{ flex: 1 }}>
                  Complete Setup
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── MAIN APP ──
  return (
    <>
      {/* Domain Warning */}
      {!isDomainValid && (
        <div className="domain-warning">
          WARNING: You are not on {VALID_DOMAIN}. This may be a phishing site. Do not connect your Ledger.
        </div>
      )}

      {/* Header with Anti-Phishing */}
      <div className="header">
        <h1 style={{ background: `linear-gradient(135deg, ${profile.accentColor} 0%, #34d399 100%)`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
          TX Web Wallet
        </h1>
        <div className="subtitle">Ledger-only. TX-only. Nothing between.</div>

        {/* Anti-Phishing Banner */}
        <div className="phishing-banner" style={{ borderColor: `${profile.accentColor}33` }}>
          <div className="phishing-greeting" style={{ color: profile.accentColor }}>
            Welcome back, {profile.name}
          </div>
          <div className="phishing-phrase">
            "{profile.secretPhrase}"
          </div>
          <div className="phishing-meta">
            <span>Last login: {formatLastLogin(profile.lastLogin)}</span>
            {profile.lastAddress && (
              <span>Last wallet: {profile.lastAddress.slice(0, 10)}...{profile.lastAddress.slice(-6)}</span>
            )}
          </div>
          <div className="phishing-domain">
            {isDomainValid ? "✓" : "✗"} {currentDomain}
          </div>
        </div>
      </div>

      {/* ── Network Toggle ── */}
      <div className="card">
        <div className="section-label">Network</div>
        <div className="network-toggle">
          <button
            className={`toggle-btn ${network === "testnet" ? "active" : ""}`}
            onClick={() => handleNetworkSwitch("testnet")}
            disabled={connecting || signing}
            style={network === "testnet" ? { background: profile.accentColor } : {}}
          >
            Testnet
          </button>
          <button
            className={`toggle-btn ${network === "mainnet" ? "active" : ""}`}
            onClick={() => handleNetworkSwitch("mainnet")}
            disabled={connecting || signing}
            style={network === "mainnet" ? { background: profile.accentColor } : {}}
          >
            Mainnet
          </button>
        </div>
      </div>

      {/* ── Connect Card ── */}
      <div className="card">
        <div className="section-label">Ledger Device</div>

        {!ledger ? (
          <>
            <button
              className="btn btn-primary"
              onClick={handleConnect}
              disabled={connecting}
              style={{ background: `linear-gradient(135deg, ${profile.accentColor}, #059669)` }}
            >
              {connecting ? (
                <><span className="spinner" /> Connecting...</>
              ) : (
                "Connect Ledger"
              )}
            </button>
            <button
              className="btn btn-outline"
              onClick={handleReleaseUSB}
              style={{ marginTop: 8, fontSize: ".72rem", opacity: 0.7 }}
            >
              Release USB
            </button>
          </>
        ) : (
          <>
            <div className="wallet-info">
              <div className="wallet-row">
                <span className="label">Status</span>
                <span className="value" style={{ color: profile.accentColor }}>
                  <span className="live-dot" style={{ backgroundColor: profile.accentColor }} /> Connected
                </span>
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
                setShowAgreement(false);
                setAgreementChecked(false);
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
                setShowAgreement(false);
                setAgreementChecked(false);
              }}
            />
          </div>

          <button
            className="btn btn-accent"
            onClick={handleCompliance}
            disabled={!recipient || !amount || signing}
            style={{ marginBottom: 8 }}
          >
            Review Transaction
          </button>

          {/* Compliance Result */}
          {complianceResult && complianceResult.status !== "PASS" && (
            <div className="status fail">
              <strong>{complianceResult.status}</strong> &mdash; {complianceResult.reason}
            </div>
          )}

          {/* Transaction Agreement */}
          {showAgreement && !txHash && (
            <div className="agreement-card">
              <div className="agreement-header">Transaction Agreement</div>
              <div className="agreement-body">
                <div className="agreement-row">
                  <span className="agreement-label">From</span>
                  <span className="agreement-value">{ledger.address.slice(0, 14)}...{ledger.address.slice(-8)}</span>
                </div>
                <div className="agreement-row">
                  <span className="agreement-label">To</span>
                  <span className="agreement-value">{recipient.slice(0, 14)}...{recipient.slice(-8)}</span>
                </div>
                <div className="agreement-row">
                  <span className="agreement-label">Amount</span>
                  <span className="agreement-value highlight">{amount} CORE</span>
                </div>
                <div className="agreement-row">
                  <span className="agreement-label">Fee</span>
                  <span className="agreement-value">0.05 CORE</span>
                </div>
                <div className="agreement-row">
                  <span className="agreement-label">Network</span>
                  <span className="agreement-value">{network}</span>
                </div>
                <div className="agreement-row">
                  <span className="agreement-label">Memo</span>
                  <span className="agreement-value">Sent via TX Web Wallet</span>
                </div>
              </div>

              <label className="agreement-check">
                <input
                  type="checkbox"
                  checked={agreementChecked}
                  onChange={(e) => setAgreementChecked(e.target.checked)}
                />
                <span>I verify these details match what my Ledger device displays</span>
              </label>

              <button
                className="btn btn-primary"
                onClick={handleSignAndSend}
                disabled={!agreementChecked || signing}
                style={{ marginTop: 12, background: agreementChecked ? `linear-gradient(135deg, ${profile.accentColor}, #059669)` : undefined }}
              >
                {signing ? (
                  <><span className="spinner" /> Signing on Ledger...</>
                ) : (
                  "Confirm & Sign on Ledger"
                )}
              </button>
            </div>
          )}

          {/* TX Result */}
          {txHash && (
            <div className="tx-result">
              <div style={{ color: "var(--green)", fontWeight: 700, marginBottom: 8 }}>
                Transaction Successful
              </div>
              <div>
                <span style={{ color: "var(--muted)" }}>TX Hash:</span>{" "}
                <a href={`${explorerBase}?tx=${txHash}`} target="_blank" rel="noopener noreferrer">
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
      {status && !showAgreement && !complianceResult && (
        <div className={`status ${status.type}`}>
          {status.message}
        </div>
      )}

      {/* Debug Toggle */}
      <div style={{ textAlign: "center", marginTop: 16 }}>
        <button
          className="btn-link"
          onClick={() => setShowDebug(!showDebug)}
        >
          {showDebug ? "Hide" : "Show"} Debug Console
        </button>
      </div>

      {/* Debug Panel */}
      {showDebug && (
        <div className="card" style={{ marginTop: 8 }}>
          <div className="section-label">Debug Console</div>
          <div className="debug-row">
            <span className="debug-label">USB Devices</span>
            <span className="debug-value">{usbDevices}</span>
          </div>
          <div className="debug-row">
            <span className="debug-label">App State</span>
            <span className="debug-value">{ledger ? "Connected" : connecting ? "Connecting..." : "Disconnected"}</span>
          </div>
          <div className="debug-row">
            <span className="debug-label">Network</span>
            <span className="debug-value">{network}</span>
          </div>
          {ledger && (
            <div className="debug-row">
              <span className="debug-label">Address</span>
              <span className="debug-value">{ledger.address}</span>
            </div>
          )}
          <div className="debug-log">
            {debugLog.length === 0 ? (
              <div style={{ color: "var(--muted)", fontStyle: "italic" }}>No events yet</div>
            ) : (
              debugLog.map((line, i) => <div key={i}>{line}</div>)
            )}
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="footer">
        <div>Powered by <a href="https://solomentelabs.com" target="_blank">TXAI</a> &bull; Built on TX (Coreum) &bull; <a href="https://github.com/EpicLoop365/Ledger-TX-Only" target="_blank">Source Code</a></div>
        <button className="btn-link" onClick={handleResetProfile} style={{ marginTop: 6, fontSize: ".6rem", color: "var(--muted)" }}>
          Reset Anti-Phishing Profile
        </button>
      </div>
    </>
  );
}

export default App;
