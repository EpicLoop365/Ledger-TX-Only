import { useState, useCallback, useEffect } from "react";
import { connectLedger, tryAutoConnect, signWithLedger, disconnectLedger, type LedgerConnection } from "./ledger";
import { fetchBalance, getAccountInfo, getChainId, broadcastTx, getDenom, getPrefix, fetchStakingInfo, checkAddressHistory, simulateTx, fetchRecentSends, fetchTxHistory, type BalanceInfo, type ValidatorInfo, type DelegationInfo, type SimulateResult, type RecentSend, type TxHistoryItem } from "./client";
import { buildAminoSignDoc, assembleTxBytes, toMicroAmount, buildDelegateSignDoc, buildUndelegateSignDoc, buildClaimRewardsSignDoc, assembleStakingTxBytes } from "./txBuilder";
import { checkCompliance, type ComplianceResult } from "./compliance";
import { BUILD_INFO } from "./build-info";

type AppTab = "send" | "stake";

type Status = { type: "pass" | "fail" | "info" | "warn"; message: string } | null;
type Network = "testnet" | "mainnet";

// ── Recent Addresses (convenience only — NOT a trust source) ──
interface RecentAddress {
  address: string;
  label?: string;
  lastUsed: number;   // Date.now()
  txCount: number;    // successful sends
}

const RECENT_ADDR_KEY = "tx_recent_addresses";
const MAX_RECENT = 5;

function loadRecentAddresses(): RecentAddress[] {
  try {
    const raw = localStorage.getItem(RECENT_ADDR_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentAddress[];
    return parsed.sort((a, b) => b.lastUsed - a.lastUsed).slice(0, MAX_RECENT);
  } catch { return []; }
}

function saveRecentAddress(address: string): void {
  const list = loadRecentAddresses();
  const existing = list.find((a) => a.address === address);
  if (existing) {
    existing.lastUsed = Date.now();
    existing.txCount += 1;
  } else {
    list.unshift({ address, lastUsed: Date.now(), txCount: 1 });
  }
  localStorage.setItem(
    RECENT_ADDR_KEY,
    JSON.stringify(list.sort((a, b) => b.lastUsed - a.lastUsed).slice(0, MAX_RECENT))
  );
}

// Address safety status for the on-chain first-contact check
type AddressSafety =
  | { status: "checking" }
  | { status: "known"; sendCount: number }
  | { status: "first_contact" }
  | { status: "error" }
  | null;

// ── Time Ago Helper ──
function getTimeAgo(isoTimestamp: string): string {
  const now = Date.now();
  const then = new Date(isoTimestamp).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(isoTimestamp).toLocaleDateString();
}

// ── Send Velocity Monitor (unusual activity detection) ──
const VELOCITY_KEY = "tx_send_timestamps";
const VELOCITY_WINDOW_MS = 10 * 60 * 1000; // 10 minute rolling window
const VELOCITY_THRESHOLD = 3; // warn after 3+ sends in 10 min

function recordSendTimestamp(): void {
  try {
    const raw = localStorage.getItem(VELOCITY_KEY);
    const timestamps: number[] = raw ? JSON.parse(raw) : [];
    timestamps.push(Date.now());
    // Keep only timestamps within the rolling window
    const cutoff = Date.now() - VELOCITY_WINDOW_MS;
    const recent = timestamps.filter((t) => t > cutoff);
    localStorage.setItem(VELOCITY_KEY, JSON.stringify(recent));
  } catch { /* ignore */ }
}

function getRecentSendCount(): { count: number; windowMinutes: number } {
  try {
    const raw = localStorage.getItem(VELOCITY_KEY);
    if (!raw) return { count: 0, windowMinutes: 10 };
    const timestamps: number[] = JSON.parse(raw);
    const cutoff = Date.now() - VELOCITY_WINDOW_MS;
    const recent = timestamps.filter((t) => t > cutoff);
    return { count: recent.length, windowMinutes: 10 };
  } catch {
    return { count: 0, windowMinutes: 10 };
  }
}

// Transaction flow steps
type TxStep = "idle" | "connect" | "review" | "sign" | "broadcast" | "done" | "failed";
const STEPS: { key: TxStep; label: string; icon: string }[] = [
  { key: "connect", label: "Connect", icon: "1" },
  { key: "review", label: "Review", icon: "2" },
  { key: "sign", label: "Sign", icon: "3" },
  { key: "broadcast", label: "Broadcast", icon: "4" },
  { key: "done", label: "Done", icon: "5" },
];

function getStepIndex(step: TxStep): number {
  return STEPS.findIndex((s) => s.key === step);
}

function StepTimeline({ currentStep, failedAt }: { currentStep: TxStep; failedAt?: TxStep }) {
  const currentIdx = getStepIndex(currentStep);
  const failedIdx = failedAt ? getStepIndex(failedAt) : -1;
  const isFailed = currentStep === "failed";
  const isDone = currentStep === "done";

  return (
    <div className="step-timeline">
      {STEPS.map((step, idx) => {
        const isComplete = isDone || (!isFailed && currentIdx > idx);
        const isActive = currentIdx === idx && !isFailed && !isDone;
        const isFailedStep = isFailed && idx === failedIdx;
        const showConnector = idx < STEPS.length - 1;

        return (
          <div className="step-item" key={step.key}>
            <div className="step-node">
              <div
                className={`step-circle ${isComplete ? "complete" : ""} ${isActive ? "active" : ""} ${isFailedStep ? "failed" : ""}`}
              >
                {isComplete ? (
                  <svg className="step-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : isFailedStep ? (
                  "!"
                ) : (
                  step.icon
                )}
              </div>
              <span className={`step-label ${isComplete ? "complete" : ""} ${isActive ? "active" : ""}`}>
                {step.label}
              </span>
            </div>
            {showConnector && (
              <div className={`step-connector ${isComplete ? "complete" : ""} ${isActive ? "active" : ""}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

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

  // Address safety (on-chain first-contact detection)
  const [addressSafety, setAddressSafety] = useState<AddressSafety>(null);
  const [recentAddresses, setRecentAddresses] = useState<RecentAddress[]>(loadRecentAddresses());

  // Transaction simulation
  const [simResult, setSimResult] = useState<SimulateResult | null>(null);

  // On-chain recent sends (loaded when Send tab opens)
  const [onChainRecents, setOnChainRecents] = useState<RecentSend[]>([]);
  const [recentsLoading, setRecentsLoading] = useState(false);

  // Transaction history panel
  const [txHistory, setTxHistory] = useState<TxHistoryItem[]>([]);
  const [txHistoryLoading, setTxHistoryLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Ledger verification popup
  const [showLedgerVerify, setShowLedgerVerify] = useState(false);
  const [ledgerVerifyType, setLedgerVerifyType] = useState<"send" | "delegate" | "undelegate" | "claim">("send");
  const [ledgerVerifyValidator, setLedgerVerifyValidator] = useState<string>("");

  // Session timeout (auto-disconnect after inactivity)
  const [lastActivity, setLastActivity] = useState<number>(Date.now());

  // Step timeline state
  const [txStep, setTxStep] = useState<TxStep>("idle");
  const [failedAtStep, setFailedAtStep] = useState<TxStep | undefined>();

  // Tab state
  const [activeTab, setActiveTab] = useState<AppTab>("send");

  // Staking state
  const [validators, setValidators] = useState<ValidatorInfo[]>([]);
  const [delegations, setDelegations] = useState<DelegationInfo[]>([]);
  const [totalRewards, setTotalRewards] = useState("0");
  const [selectedValidator, setSelectedValidator] = useState<string>("");
  const [stakeAmount, setStakeAmount] = useState("");
  const [stakeAction, setStakeAction] = useState<"delegate" | "undelegate">("delegate");
  const [stakingLoading, setStakingLoading] = useState(false);

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
    setTxStep("connect");
    setFailedAtStep(undefined);
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

      setTxStep("review");
      setStatus({ type: "pass", message: "Ledger connected successfully" });
    } catch (err) {
      const msg = (err as Error).message;
      log(`ERROR: ${msg}`);
      setFailedAtStep("connect");
      setTxStep("failed");
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

  // ── Auto-connect on page load (previously authorized Ledger) ──
  useEffect(() => {
    // Only attempt if not already connected and not currently connecting
    if (ledger || connecting) return;

    let cancelled = false;
    const attempt = async () => {
      try {
        const prefix = getPrefix(network);
        const connection = await tryAutoConnect(prefix);
        if (cancelled || !connection) return;

        setLedger(connection);
        setTxStep("review");
        setStatus({ type: "pass", message: "Ledger auto-connected" });

        // Update profile
        if (profile) {
          const updated = { ...profile, lastLogin: new Date().toISOString(), lastAddress: connection.address };
          saveProfile(updated);
          setProfile(updated);
        }

        // Fetch balance
        const bal = await fetchBalance(connection.address, network);
        if (!cancelled) setBalance(bal);
      } catch {
        // Silent fail — user can always click Connect manually
      }
    };

    attempt();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Run once on mount only

  // ── Session Timeout (auto-disconnect after 10 min inactivity) ──
  const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

  // Track user activity — reset the timer on any interaction
  useEffect(() => {
    const resetActivity = () => setLastActivity(Date.now());
    const events = ["mousedown", "keydown", "scroll", "touchstart"] as const;
    events.forEach((e) => window.addEventListener(e, resetActivity));
    return () => {
      events.forEach((e) => window.removeEventListener(e, resetActivity));
    };
  }, []);

  // Check for timeout every 30 seconds
  useEffect(() => {
    if (!ledger) return; // No need to check if not connected

    const interval = setInterval(async () => {
      const elapsed = Date.now() - lastActivity;
      if (elapsed >= SESSION_TIMEOUT_MS) {
        try {
          await disconnectLedger(ledger.transport);
        } catch { /* ignore */ }
        setLedger(null);
        setBalance(null);
        setTxStep("idle");
        setStatus({
          type: "warn",
          message: "Session timed out after 10 minutes of inactivity. Ledger disconnected for security. Please reconnect.",
        });
      }
    }, 30_000);

    return () => clearInterval(interval);
  }, [ledger, lastActivity]);

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
    setTxStep("idle");
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
      setTxStep("idle");
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

  // ── Load Staking Info ──
  const loadStakingInfo = useCallback(async () => {
    if (!ledger) return;
    setStakingLoading(true);
    try {
      const info = await fetchStakingInfo(ledger.address, network);
      setValidators(info.validators);
      setDelegations(info.delegations);
      setTotalRewards(info.totalRewards);

      // Auto-select validator: prefer localStorage last-used, then first delegation
      if (!selectedValidator) {
        const saved = localStorage.getItem("tx_last_validator");
        const validAddrs = new Set(info.validators.map((v) => v.operatorAddress));
        if (saved && validAddrs.has(saved)) {
          setSelectedValidator(saved);
        } else if (info.delegations.length > 0) {
          setSelectedValidator(info.delegations[0].validatorAddress);
        }
      }
    } catch (err) {
      console.error("Failed to load staking info:", err);
    }
    setStakingLoading(false);
  }, [ledger, network, selectedValidator]);

  // Load staking info when switching to stake tab
  useEffect(() => {
    if (activeTab === "stake" && ledger) {
      loadStakingInfo();
    }
  }, [activeTab, ledger, loadStakingInfo]);

  // Load on-chain recent sends when switching to send tab
  useEffect(() => {
    if (activeTab === "send" && ledger && onChainRecents.length === 0 && !recentsLoading) {
      setRecentsLoading(true);
      fetchRecentSends(ledger.address, network, 10)
        .then((sends) => setOnChainRecents(sends))
        .catch(() => {})
        .finally(() => setRecentsLoading(false));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, ledger, network]);

  // Load full tx history when wallet connects
  useEffect(() => {
    if (ledger && txHistory.length === 0 && !txHistoryLoading) {
      setTxHistoryLoading(true);
      fetchTxHistory(ledger.address, network, 10)
        .then((history) => setTxHistory(history))
        .catch(() => {})
        .finally(() => setTxHistoryLoading(false));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledger, network]);

  // ── Stake / Unstake ──
  const handleStake = useCallback(async () => {
    if (!ledger || !selectedValidator || !stakeAmount) return;

    setSigning(true);
    setTxStep("sign");
    setFailedAtStep(undefined);
    setStatus({ type: "info", message: `Preparing ${stakeAction}...` });

    try {
      const microAmount = toMicroAmount(parseFloat(stakeAmount));
      const denom = getDenom(network);
      const { accountNumber, sequence } = await getAccountInfo(ledger.address, network);
      const chainId = await getChainId(network);

      const buildFn = stakeAction === "delegate" ? buildDelegateSignDoc : buildUndelegateSignDoc;
      const { signDoc, signDocString } = buildFn({
        delegatorAddress: ledger.address,
        validatorAddress: selectedValidator,
        amount: microAmount,
        denom,
        chainId,
        accountNumber,
        sequence,
        memo: `${stakeAction === "delegate" ? "Staked" : "Unstaked"} via TX Web Wallet`,
      });

      setStatus({ type: "warn", message: "Please confirm on your Ledger device..." });
      const signature = await signWithLedger(ledger.app, signDocString, ledger.prefix);

      setTxStep("broadcast");
      setStatus({ type: "info", message: "Broadcasting..." });
      const txBytes = assembleStakingTxBytes(signDoc, signature, ledger.publicKey);
      const result = await broadcastTx(txBytes, network);

      if (result.success) {
        setTxHash(result.txHash);
        setTxStep("done");
        setStatus({ type: "pass", message: `${stakeAction === "delegate" ? "Stake" : "Unstake"} successful!` });
        setStakeAmount("");
        setTimeout(() => { handleRefreshBalance(); loadStakingInfo(); }, 3000);
      } else {
        setFailedAtStep("broadcast");
        setTxStep("failed");
        setStatus({ type: "fail", message: `Failed: ${result.error}` });
      }
    } catch (err: any) {
      setFailedAtStep("sign");
      setTxStep("failed");
      const msg = err.message || String(err);
      if (msg.includes("rejected") || msg.includes("0x6985")) {
        setStatus({ type: "fail", message: "Rejected on Ledger device" });
      } else {
        setStatus({ type: "fail", message: `Failed: ${msg}` });
      }
    }
    setSigning(false);
  }, [ledger, selectedValidator, stakeAmount, stakeAction, network, handleRefreshBalance, loadStakingInfo]);

  // ── Max Stake ──
  // Sets stakeAmount to the largest value that still leaves enough for
  // 3 more transactions so the wallet is never stuck at zero after a Max
  // click. Reserve = 4 × fee (1 for the current stake tx + 3 future txs).
  const handleMaxStake = useCallback(() => {
    if (!balance) {
      setStatus({ type: "fail", message: "Balance not loaded yet" });
      return;
    }
    const balanceMicro = parseInt(balance.amount || "0");
    const FEE_MICRO = 50000; // 0.05 CORE per tx — matches fee in txBuilder.ts
    const RESERVE_TXS = 4; // this stake tx + 3 future txs
    const reserveMicro = FEE_MICRO * RESERVE_TXS;
    if (balanceMicro <= reserveMicro) {
      setStatus({
        type: "fail",
        message: "Insufficient balance — need at least 0.20 CORE (4 × 0.05 fee reserve)",
      });
      return;
    }
    const maxMicro = balanceMicro - reserveMicro;
    // Round down to nearest whole CORE for a clean stake amount
    const maxWhole = Math.floor(maxMicro / 1_000_000);
    const reservedForGas = ((balanceMicro - (maxWhole * 1_000_000)) / 1_000_000).toFixed(6);
    if (maxWhole <= 0) {
      setStatus({
        type: "fail",
        message: "Balance too low to stake a whole CORE after reserving for gas",
      });
      return;
    }
    setStakeAmount(String(maxWhole));
    setStatus({
      type: "info",
      message: `Max set to ${maxWhole} CORE — ${reservedForGas} CORE reserved for gas + 3 future txs`,
    });
  }, [balance]);

  // ── Claim Rewards ──
  const handleClaimRewards = useCallback(async (validatorAddress: string) => {
    if (!ledger) return;

    setSigning(true);
    setTxStep("sign");
    setFailedAtStep(undefined);
    setStatus({ type: "info", message: "Preparing claim..." });

    try {
      const denom = getDenom(network);
      const { accountNumber, sequence } = await getAccountInfo(ledger.address, network);
      const chainId = await getChainId(network);

      const { signDoc, signDocString } = buildClaimRewardsSignDoc({
        delegatorAddress: ledger.address,
        validatorAddress,
        chainId,
        accountNumber,
        sequence,
        denom,
        memo: "Claimed via TX Web Wallet",
      });

      setStatus({ type: "warn", message: "Please confirm on your Ledger device..." });
      const signature = await signWithLedger(ledger.app, signDocString, ledger.prefix);

      setTxStep("broadcast");
      setStatus({ type: "info", message: "Broadcasting..." });
      const txBytes = assembleStakingTxBytes(signDoc, signature, ledger.publicKey);
      const result = await broadcastTx(txBytes, network);

      if (result.success) {
        setTxHash(result.txHash);
        setTxStep("done");
        setStatus({ type: "pass", message: "Rewards claimed!" });
        setTimeout(() => { handleRefreshBalance(); loadStakingInfo(); }, 3000);
      } else {
        setFailedAtStep("broadcast");
        setTxStep("failed");
        setStatus({ type: "fail", message: `Failed: ${result.error}` });
      }
    } catch (err: any) {
      setFailedAtStep("sign");
      setTxStep("failed");
      const msg = err.message || String(err);
      setStatus({ type: "fail", message: msg.includes("rejected") ? "Rejected on Ledger" : `Failed: ${msg}` });
    }
    setSigning(false);
  }, [ledger, network, handleRefreshBalance, loadStakingInfo]);

  // ── Run Compliance + Simulation + Address History + Amount Sanity (parallel) ──
  const handleCompliance = useCallback(async () => {
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum)) {
      setComplianceResult({ status: "FAIL", reason: "Invalid amount" });
      return;
    }

    // Synchronous compliance check first (fast gate)
    const result = checkCompliance(recipient, amountNum, network);
    setComplianceResult(result);
    setTxHash(null);
    setShowAgreement(false);
    setAgreementChecked(false);
    setSimResult(null);

    if (result.status !== "PASS") {
      setStatus({ type: "fail", message: `Compliance check failed: ${result.reason}` });
      return;
    }

    // Compliance passed — fire simulation + address history in parallel
    setStatus({ type: "info", message: "Verifying transaction on-chain..." });
    setAddressSafety({ status: "checking" });

    const denom = getDenom(network);
    const microAmount = toMicroAmount(amountNum);

    try {
      if (ledger) {
        // Fire all three checks in parallel: address history + account info (for sim) + simulate
        const [history, acctInfo] = await Promise.all([
          checkAddressHistory(ledger.address, recipient.trim(), network),
          getAccountInfo(ledger.address, network).catch(() => ({ accountNumber: 0, sequence: 0 })),
        ]);

        // Now simulate with the public key + sequence (needed by Cosmos SDK simulate)
        const sim = await simulateTx(
          ledger.address, recipient.trim(), microAmount, denom, network,
          ledger.publicKey, acctInfo.sequence
        );

        // Address history result
        if (history.hasPriorSends) {
          setAddressSafety({ status: "known", sendCount: history.sendCount });
        } else {
          setAddressSafety({ status: "first_contact" });
        }

        // Simulation result
        setSimResult(sim);

        // Amount sanity check (>50% of balance)
        const balanceMicro = parseInt(balance?.amount || "0", 10);
        const sendMicro = parseInt(microAmount, 10);
        const pct = balanceMicro > 0 ? (sendMicro / balanceMicro) * 100 : 0;

        // Build composite status message
        const warnings: string[] = [];

        if (!sim.success) {
          warnings.push(`Simulation warning: ${sim.error}`);
        }
        if (!history.hasPriorSends) {
          warnings.push("First contact — never sent to this address before");
        }
        if (pct > 50) {
          warnings.push(`Sending ${pct.toFixed(0)}% of your total balance`);
        }

        if (warnings.length > 0) {
          setStatus({ type: "warn", message: warnings.join(". ") + ". Verify carefully on your Ledger." });
        } else {
          setStatus({ type: "pass", message: `All checks passed. Estimated gas: ${sim.gasUsed.toLocaleString()}.` });
        }
      } else {
        setAddressSafety(null);
        setSimResult(null);
        setStatus({ type: "pass", message: "Compliance check passed." });
      }
    } catch {
      setAddressSafety({ status: "error" });
      setSimResult(null);
      setStatus({ type: "pass", message: "Compliance passed. (On-chain checks unavailable)" });
    }

    setShowAgreement(true);
    setTxStep("review");
  }, [recipient, amount, ledger, network, balance]);

  // ── Sign & Send ──
  const handleSignAndSend = useCallback(async () => {
    if (!ledger || !complianceResult || complianceResult.status !== "PASS" || !agreementChecked) return;

    setSigning(true);
    setTxStep("sign");
    setFailedAtStep(undefined);
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

      setTxStep("broadcast");
      setStatus({ type: "info", message: "Broadcasting transaction..." });
      try {
        const txBytes = assembleTxBytes(signDoc, signature, ledger.publicKey);
        console.log("[TX] Tx bytes assembled:", txBytes.length, "bytes");

        const result = await broadcastTx(txBytes, network);
        console.log("[TX] Broadcast result:", JSON.stringify(result));

        if (result.success) {
          setTxHash(result.txHash);
          setTxStep("done");
          setStatus({ type: "pass", message: "Transaction broadcast successfully!" });
          setShowAgreement(false);
          // Save to recent addresses (convenience only — not a trust source)
          saveRecentAddress(recipient.trim());
          setRecentAddresses(loadRecentAddresses());
          setAddressSafety(null);
          // Record for velocity monitoring
          recordSendTimestamp();
          setTimeout(() => handleRefreshBalance(), 3000);
        } else {
          setFailedAtStep("broadcast");
          setTxStep("failed");
          setStatus({ type: "fail", message: `Broadcast failed: ${result.error}` });
        }
      } catch (assembleErr: any) {
        console.error("[TX] Assembly/broadcast error:", assembleErr);
        setFailedAtStep("broadcast");
        setTxStep("failed");
        setStatus({ type: "fail", message: `TX assembly failed: ${assembleErr.message}` });
      }
    } catch (err: any) {
      console.error("[TX] Sign error:", err);
      const msg = err.message || String(err);
      setFailedAtStep("sign");
      setTxStep("failed");
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

  // ── Ledger Verification Popup ──
  // Shows users exactly what their Ledger screen will display before signing
  const handleLedgerVerifyProceed = useCallback(() => {
    setShowLedgerVerify(false);
    if (ledgerVerifyType === "send") {
      handleSignAndSend();
    } else if (ledgerVerifyType === "delegate" || ledgerVerifyType === "undelegate") {
      handleStake();
    } else if (ledgerVerifyType === "claim") {
      handleClaimRewards(ledgerVerifyValidator);
    }
  }, [ledgerVerifyType, ledgerVerifyValidator, handleSignAndSend, handleStake, handleClaimRewards]);

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
          <div className="phishing-left">
            <div className="phishing-greeting" style={{ color: profile.accentColor }}>
              Welcome back, {profile.name}
            </div>
            <div className="phishing-phrase">
              "{profile.secretPhrase}"
            </div>
          </div>
          <div className="phishing-right">
            <div className="phishing-meta">
              <span>{formatLastLogin(profile.lastLogin)}</span>
              {profile.lastAddress && (
                <span>{profile.lastAddress.slice(0, 8)}...{profile.lastAddress.slice(-4)}</span>
              )}
            </div>
            <div className="phishing-domain">
              {isDomainValid ? "✓" : "✗"} {currentDomain}
            </div>
          </div>
        </div>
      </div>

      {/* ── Step Timeline ── */}
      {txStep !== "idle" && <StepTimeline currentStep={txStep} failedAt={failedAtStep} />}

      {/* ── When NOT connected: Network + Connect ── */}
      {!ledger && (
        <>
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

          <div className="card">
            <div className="section-label">Ledger Device</div>
            <button
              className={`btn btn-primary ${!connecting ? "btn-connect-pulse" : ""}`}
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
              style={{ marginTop: 6, fontSize: ".68rem", opacity: 0.7 }}
            >
              Release USB
            </button>
          </div>
        </>
      )}

      {/* ── When connected: Wallet address + balance bar ── */}
      {ledger && (
        <div className="connected-bar">
          <span className="live-dot" style={{ backgroundColor: profile.accentColor }} />
          <div className="connected-bar-info">
            <div className="connected-bar-item" style={{ flex: "1 1 100%" }}>
              <span
                className="cb-value wallet-address"
                onClick={() => {
                  navigator.clipboard.writeText(ledger.address);
                  setStatus({ type: "info", message: "Address copied to clipboard" });
                }}
                title="Click to copy full address"
              >
                {ledger.address}
              </span>
            </div>
            <div className="connected-bar-item">
              <span className="cb-value green">{balance?.display || "..."}</span>
            </div>
            <div className="connected-bar-item">
              <span className="cb-label">{network}</span>
            </div>
          </div>
          <div className="connected-bar-actions">
            <button className="btn-sm" onClick={handleRefreshBalance}>Refresh</button>
            <button className="btn-sm danger" onClick={handleDisconnect}>Disconnect</button>
          </div>
        </div>
      )}

      {/* ── Two-Panel Dashboard ── */}
      {ledger && (
        <div className="dashboard-layout">
          <div className="dashboard-left">

      {/* ── Tab Toggle ── */}
      <div className="card" style={{ padding: "8px 10px", marginBottom: 8 }}>
          <div className="network-toggle">
            <button
              className={`toggle-btn ${activeTab === "send" ? "active" : ""}`}
              onClick={() => setActiveTab("send")}
              disabled={signing}
              style={activeTab === "send" ? { background: profile.accentColor } : {}}
            >
              Send
            </button>
            <button
              className={`toggle-btn ${activeTab === "stake" ? "active" : ""}`}
              onClick={() => setActiveTab("stake")}
              disabled={signing}
              style={activeTab === "stake" ? { background: profile.accentColor } : {}}
            >
              Stake
            </button>
          </div>
        </div>

      {/* ── Send Tab ── */}
      {activeTab === "send" && (
        <div className="card card-enter">
          <div className="section-label">Send Transaction</div>

          {/* ── Recent Sends (on-chain history — tamper-proof) ── */}
          {recentsLoading && (
            <div className="recent-addresses">
              <div className="recent-addresses-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="spinner" style={{ width: 10, height: 10 }} /> Loading send history from chain...
              </div>
            </div>
          )}
          {!recentsLoading && onChainRecents.length > 0 && (
            <div className="recent-addresses">
              <div className="recent-addresses-label">Recent Sends (on-chain)</div>
              <div className="recent-addresses-chips">
                {onChainRecents.slice(0, 5).map((rs) => (
                  <button
                    key={rs.txHash}
                    type="button"
                    className={`recent-chip ${recipient === rs.recipient ? "active" : ""}`}
                    onClick={() => {
                      setRecipient(rs.recipient);
                      setComplianceResult(null);
                      setTxHash(null);
                      setShowAgreement(false);
                      setAgreementChecked(false);
                      setAddressSafety(null);
                    }}
                    title={`${rs.recipient}\n${rs.amount} CORE • ${rs.timestamp ? new Date(rs.timestamp).toLocaleDateString() : ""}`}
                  >
                    <span className="recent-chip-addr">
                      {rs.recipient.slice(0, 8)}...{rs.recipient.slice(-6)}
                    </span>
                    <span className="recent-chip-count">{rs.amount}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

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
                setAddressSafety(null);
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

          {complianceResult && complianceResult.status !== "PASS" && (
            <div className="status fail">
              <strong>{complianceResult.status}</strong> &mdash; {complianceResult.reason}
            </div>
          )}

          {showAgreement && !txHash && (
            <div className="agreement-card animate-slide-up">
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
              </div>

              {/* ── On-chain Address Safety Banner ── */}
              {addressSafety?.status === "checking" && (
                <div className="address-safety checking">
                  <span className="spinner" style={{ width: 12, height: 12 }} /> Checking address history on-chain...
                </div>
              )}
              {addressSafety?.status === "first_contact" && (
                <div className="address-safety first-contact">
                  <div className="address-safety-icon">⚠</div>
                  <div className="address-safety-text">
                    <strong>First contact</strong> — You have never sent to this address before.
                    <br />Verify every character on your Ledger screen before approving.
                  </div>
                </div>
              )}
              {addressSafety?.status === "known" && (
                <div className="address-safety known">
                  <div className="address-safety-icon">✓</div>
                  <div className="address-safety-text">
                    You&apos;ve sent to this address <strong>{addressSafety.sendCount} time{addressSafety.sendCount > 1 ? "s" : ""}</strong> before.
                    <br />Still verify the address on your Ledger screen.
                  </div>
                </div>
              )}

              {/* ── Transaction Simulation Result ── */}
              {simResult && simResult.success && (
                <div className="address-safety known" style={{ borderColor: "rgba(52,211,153,.15)" }}>
                  <div className="address-safety-icon">⚡</div>
                  <div className="address-safety-text">
                    Simulation passed — estimated gas: <strong>{simResult.gasUsed.toLocaleString()}</strong>
                  </div>
                </div>
              )}
              {simResult && !simResult.success && (
                <div className="address-safety first-contact">
                  <div className="address-safety-icon">⚠</div>
                  <div className="address-safety-text">
                    <strong>Simulation failed</strong> — {simResult.error}
                    <br />This transaction may fail on-chain. Proceed with caution.
                  </div>
                </div>
              )}

              {/* ── Amount Sanity Check ── */}
              {balance && (() => {
                const balMicro = parseInt(balance.amount || "0", 10);
                const sendMicro = Math.round(parseFloat(amount) * 1_000_000);
                const pct = balMicro > 0 ? (sendMicro / balMicro) * 100 : 0;
                if (pct > 90) {
                  return (
                    <div className="address-safety first-contact" style={{ borderColor: "rgba(239,68,68,.5)", background: "rgba(239,68,68,.1)" }}>
                      <div className="address-safety-icon">🛑</div>
                      <div className="address-safety-text" style={{ color: "#f87171" }}>
                        <strong>Sending {pct.toFixed(0)}% of your total balance!</strong>
                        <br />This will leave almost nothing in your wallet. Are you sure?
                      </div>
                    </div>
                  );
                }
                if (pct > 50) {
                  return (
                    <div className="address-safety first-contact">
                      <div className="address-safety-icon">⚠</div>
                      <div className="address-safety-text">
                        <strong>Large transfer — {pct.toFixed(0)}% of your balance.</strong>
                        <br />Double-check the amount before approving.
                      </div>
                    </div>
                  );
                }
                return null;
              })()}

              {/* ── Send Velocity Warning ── */}
              {(() => {
                const velocity = getRecentSendCount();
                if (velocity.count >= VELOCITY_THRESHOLD) {
                  return (
                    <div className="address-safety first-contact" style={{ borderColor: "rgba(245,158,11,.5)" }}>
                      <div className="address-safety-icon">⚡</div>
                      <div className="address-safety-text">
                        <strong>Unusual activity — {velocity.count} transactions in the last {velocity.windowMinutes} minutes.</strong>
                        <br />Confirm this is intentional and your session hasn&apos;t been compromised.
                      </div>
                    </div>
                  );
                }
                return null;
              })()}

              <label className="agreement-check">
                <input
                  type="checkbox"
                  checked={agreementChecked}
                  onChange={(e) => setAgreementChecked(e.target.checked)}
                />
                <span>I verify these details match what my Ledger device displays</span>
              </label>

              <button
                className={`btn btn-primary ${signing ? "btn-signing" : ""}`}
                onClick={() => {
                  setLedgerVerifyType("send");
                  setShowLedgerVerify(true);
                }}
                disabled={!agreementChecked || signing}
                style={{ marginTop: 8, background: agreementChecked && !signing ? `linear-gradient(135deg, ${profile.accentColor}, #059669)` : undefined }}
              >
                {signing ? <><span className="spinner" /> Signing...</> : "Confirm & Sign on Ledger"}
              </button>
            </div>
          )}

          {txHash && (
            <div className="tx-result animate-success">
              <div style={{ color: "var(--green)", fontWeight: 700, marginBottom: 4 }}>Transaction Successful</div>
              <div>
                <span style={{ color: "var(--muted)" }}>Hash:</span>{" "}
                <a href={`${explorerBase}?tx=${txHash}`} target="_blank" rel="noopener noreferrer">
                  {txHash.slice(0, 12)}...{txHash.slice(-6)}
                </a>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Stake Tab ── */}
      {activeTab === "stake" && (
        <div className="card card-enter">
          {/* Total Staked Summary */}
          {delegations.length > 0 && (
            <div className="staking-summary">
              <div className="staking-summary-row">
                <span className="staking-summary-label">Total Staked</span>
                <span className="staking-summary-value">
                  {(delegations.reduce((sum, d) => sum + parseInt(d.balance), 0) / 1_000_000).toFixed(2)} CORE
                </span>
              </div>
              <div className="staking-summary-row">
                <span className="staking-summary-label">Pending Rewards</span>
                <span className="staking-summary-value green">
                  +{(parseInt(totalRewards) / 1_000_000).toFixed(4)} CORE
                </span>
              </div>
              <div className="staking-summary-row">
                <span className="staking-summary-label">Validators</span>
                <span className="staking-summary-value">{delegations.length}</span>
              </div>
            </div>
          )}

          {/* My Delegations */}
          {delegations.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div className="section-label">My Delegations</div>
              {delegations.map((d) => {
                const balDisplay = (parseInt(d.balance) / 1_000_000).toFixed(2);
                const rewDisplay = (parseInt(d.rewards) / 1_000_000).toFixed(4);
                const hasRewards = parseInt(d.rewards) > 0;
                return (
                  <div key={d.validatorAddress} className="delegation-row">
                    <div className="delegation-info">
                      <span className="delegation-name">{d.validatorMoniker}</span>
                      <span className="delegation-amount">{balDisplay} CORE</span>
                      {hasRewards && (
                        <span className="delegation-rewards">+{rewDisplay} pending</span>
                      )}
                    </div>
                    {hasRewards && (
                      <button
                        className="btn-sm"
                        onClick={() => {
                          setLedgerVerifyType("claim");
                          setLedgerVerifyValidator(d.validatorAddress);
                          setShowLedgerVerify(true);
                        }}
                        disabled={signing}
                        style={{ color: "var(--green)", borderColor: "rgba(52,211,153,.3)" }}
                      >
                        Claim
                      </button>
                    )}
                  </div>
                );
              })}
              {parseInt(totalRewards) > 0 && (
                <div style={{ marginTop: 8, fontSize: "1.25rem", fontWeight: 700, fontFamily: "var(--mono)", color: "var(--green)", textAlign: "right" }}>
                  Total pending: {(parseInt(totalRewards) / 1_000_000).toFixed(4)} CORE
                </div>
              )}
            </div>
          )}

          {delegations.length === 0 && !stakingLoading && (
            <div style={{ fontSize: ".72rem", color: "var(--muted)", marginBottom: 12, textAlign: "center" }}>
              No active delegations
            </div>
          )}

          {stakingLoading && (
            <div style={{ fontSize: ".72rem", color: "var(--muted)", marginBottom: 12, textAlign: "center" }}>
              <span className="spinner" style={{ width: 12, height: 12 }} /> Loading staking info...
            </div>
          )}

          {/* Stake / Unstake */}
          <div className="section-label" style={{ marginTop: 4 }}>
            {stakeAction === "delegate" ? "Stake" : "Unstake"} CORE
          </div>

          <div className="network-toggle" style={{ marginBottom: 8 }}>
            <button
              className={`toggle-btn ${stakeAction === "delegate" ? "active" : ""}`}
              onClick={() => setStakeAction("delegate")}
              style={stakeAction === "delegate" ? { background: "var(--green)" } : {}}
            >
              Stake
            </button>
            <button
              className={`toggle-btn ${stakeAction === "undelegate" ? "active" : ""}`}
              onClick={() => setStakeAction("undelegate")}
              style={stakeAction === "undelegate" ? { background: "var(--yellow)" } : {}}
            >
              Unstake
            </button>
          </div>

          <div className="input-group validator-selector">
            <label>Validator</label>
            <select
              value={selectedValidator}
              onChange={(e) => {
                setSelectedValidator(e.target.value);
                if (e.target.value) localStorage.setItem("tx_last_validator", e.target.value);
              }}
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 7,
                border: selectedValidator
                  ? "1.5px solid var(--green)"
                  : "1.5px solid var(--yellow)",
                background: "var(--bg)",
                color: "var(--text)",
                fontFamily: "var(--mono)",
                fontSize: "1rem",
                fontWeight: 600,
                outline: "none",
              }}
            >
              <option value="">⬇ Select a validator...</option>
              {validators.map((v) => {
                const isDelegated = delegations.some((d) => d.validatorAddress === v.operatorAddress);
                return (
                  <option key={v.operatorAddress} value={v.operatorAddress}>
                    {isDelegated ? "★ " : ""}{v.moniker} ({(parseFloat(v.commission) * 100).toFixed(0)}% fee)
                  </option>
                );
              })}
            </select>
            {selectedValidator && (() => {
              const v = validators.find((x) => x.operatorAddress === selectedValidator);
              const d = delegations.find((x) => x.validatorAddress === selectedValidator);
              const stakedAmount = d ? (parseInt(d.balance) / 1_000_000).toFixed(2) : "0.00";
              const pendingRewards = d ? (parseInt(d.rewards) / 1_000_000).toFixed(4) : "0.0000";
              const hasStake = d && parseInt(d.balance) > 0;
              return v ? (
                <div className="validator-detail-badge">
                  <div className="validator-detail-name">{v.moniker}</div>
                  <div className="validator-detail-stats">
                    <div className="validator-detail-stat">
                      <span className="validator-detail-label">Staked</span>
                      <span className="validator-detail-value">{stakedAmount} CORE</span>
                    </div>
                    {hasStake && (
                      <div className="validator-detail-stat">
                        <span className="validator-detail-label">Pending</span>
                        <span className="validator-detail-value green">+{pendingRewards} CORE</span>
                      </div>
                    )}
                    <div className="validator-detail-stat">
                      <span className="validator-detail-label">Commission</span>
                      <span className="validator-detail-value">{(parseFloat(v.commission) * 100).toFixed(1)}%</span>
                    </div>
                  </div>
                </div>
              ) : null;
            })()}
          </div>

          <div className="input-group">
            <label>Amount (CORE)</label>
            <input
              type="number"
              placeholder="0.00"
              min="0"
              step="0.000001"
              value={stakeAmount}
              onChange={(e) => setStakeAmount(e.target.value)}
            />
            {stakeAction === "delegate" && balance && (
              <div className="input-helper">
                <span className="input-helper-label">
                  Available: <strong>{balance.display}</strong>
                </span>
                <button
                  type="button"
                  className="btn-max"
                  onClick={handleMaxStake}
                  disabled={signing}
                >
                  MAX
                </button>
              </div>
            )}
          </div>

          <button
            className="btn btn-primary"
            onClick={() => {
              setLedgerVerifyType(stakeAction);
              setShowLedgerVerify(true);
            }}
            disabled={!selectedValidator || !stakeAmount || signing}
            style={{ background: stakeAction === "delegate"
              ? `linear-gradient(135deg, var(--green), #059669)`
              : `linear-gradient(135deg, var(--yellow), #d97706)` }}
          >
            {signing ? (
              <><span className="spinner" /> Signing...</>
            ) : (
              stakeAction === "delegate" ? "Stake on Ledger" : "Unstake on Ledger"
            )}
          </button>

          {txHash && (
            <div className="tx-result animate-success" style={{ marginTop: 8 }}>
              <div style={{ color: "var(--green)", fontWeight: 700, marginBottom: 4 }}>Success</div>
              <div>
                <span style={{ color: "var(--muted)" }}>Hash:</span>{" "}
                <a href={`${explorerBase}?tx=${txHash}`} target="_blank" rel="noopener noreferrer">
                  {txHash.slice(0, 12)}...{txHash.slice(-6)}
                </a>
              </div>
            </div>
          )}

          <button
            className="btn-sm"
            onClick={loadStakingInfo}
            disabled={stakingLoading}
            style={{ marginTop: 8, width: "100%", textAlign: "center" }}
          >
            {stakingLoading ? "Loading..." : "Refresh Staking Info"}
          </button>
        </div>
      )}

      {/* Status Message */}
      {status && !showAgreement && !complianceResult && (
        <div className={`status ${status.type}`}>
          {status.message}
        </div>
      )}

          </div>{/* end dashboard-left */}

          <div className="dashboard-right">

      {/* ── Transaction History Panel ── */}
        <div className="card" style={{ marginBottom: 0 }}>
          <button
            type="button"
            className="tx-history-toggle"
            onClick={() => setShowHistory(!showHistory)}
            style={{ padding: "12px 0" }}
          >
            <span style={{ fontSize: "1rem" }}>Transaction History</span>
            <span style={{ fontSize: ".8rem", color: "var(--muted)" }}>
              {showHistory ? "▲ Hide" : `▼ Show (${txHistory.length})`}
            </span>
          </button>

          {showHistory && (
            <div className="tx-history-list">
              {txHistoryLoading && (
                <div style={{ padding: 10, textAlign: "center", color: "var(--muted)", fontSize: ".75rem" }}>
                  <span className="spinner" style={{ width: 12, height: 12 }} /> Loading from chain...
                </div>
              )}
              {!txHistoryLoading && txHistory.length === 0 && (
                <div style={{ padding: 10, textAlign: "center", color: "var(--muted)", fontSize: ".75rem" }}>
                  No transactions found
                </div>
              )}
              {txHistory.map((tx, i) => {
                const typeLabel: Record<string, string> = {
                  send: "Sent", receive: "Received", delegate: "Staked",
                  undelegate: "Unstaked", claim: "Claimed", other: "Other"
                };
                const typeIcon: Record<string, string> = {
                  send: "↗", receive: "↙", delegate: "⬆",
                  undelegate: "⬇", claim: "★", other: "•"
                };
                const typeColor: Record<string, string> = {
                  send: "#f87171", receive: "var(--green)", delegate: "#60a5fa",
                  undelegate: "#fbbf24", claim: "var(--green)", other: "var(--muted)"
                };
                const ago = tx.timestamp ? getTimeAgo(tx.timestamp) : "";
                return (
                  <div key={`${tx.txHash}-${i}`} className="tx-history-row">
                    <span className="tx-history-icon" style={{ color: typeColor[tx.type] }}>
                      {typeIcon[tx.type]}
                    </span>
                    <div className="tx-history-details">
                      <div className="tx-history-type" style={{ color: typeColor[tx.type] }}>
                        {typeLabel[tx.type] || tx.type}
                        {tx.amount && <span className="tx-history-amount"> {tx.amount} CORE</span>}
                      </div>
                      <div className="tx-history-meta">
                        {tx.counterparty && (
                          <span>{tx.counterparty.slice(0, 10)}...{tx.counterparty.slice(-4)}</span>
                        )}
                        {ago && <span className="tx-history-time">{ago}</span>}
                      </div>
                    </div>
                    <a
                      href={`https://${network === "mainnet" ? "explorer" : "explorer.testnet-1"}.coreum.dev/coreum/transactions/${tx.txHash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="tx-history-link"
                      title="View on explorer"
                    >
                      ↗
                    </a>
                  </div>
                );
              })}
            </div>
          )}
        </div>

      {/* ── Security Status Card ── */}
        <div className="card security-status">
          <div className="security-status-title">Security Status</div>
          <div className="security-row">
            <span className="security-icon" style={{ color: "var(--green)" }}>✓</span>
            <span className="security-label">Ledger hardware-only signing</span>
          </div>
          <div className="security-row">
            <span className="security-icon" style={{ color: "var(--green)" }}>✓</span>
            <span className="security-label">Session timeout</span>
            <span className="security-value">{Math.max(0, Math.ceil((10 * 60 * 1000 - (Date.now() - lastActivity)) / 60000))}m left</span>
          </div>
          <div className="security-row">
            <span className="security-icon" style={{ color: getRecentSendCount().count >= VELOCITY_THRESHOLD ? "#fbbf24" : "var(--green)" }}>
              {getRecentSendCount().count >= VELOCITY_THRESHOLD ? "⚠" : "✓"}
            </span>
            <span className="security-label">Send velocity</span>
            <span className="security-value">{getRecentSendCount().count} in 10m</span>
          </div>
          <div className="security-row">
            <span className="security-icon" style={{ color: "var(--green)" }}>✓</span>
            <span className="security-label">On-chain address verification</span>
          </div>
          <div className="security-row">
            <span className="security-icon" style={{ color: "var(--green)" }}>✓</span>
            <span className="security-label">Transaction simulation</span>
          </div>
          <div className="security-row">
            <span className="security-icon" style={{ color: "var(--green)" }}>✓</span>
            <span className="security-label">Cross-chain address detection</span>
          </div>
          <div className="security-row">
            <span className="security-icon" style={{ color: "var(--green)" }}>✓</span>
            <span className="security-label">Open source verified build</span>
          </div>
          <div className="security-row">
            <span className="security-icon" style={{ color: "var(--green)" }}>✓</span>
            <span className="security-label">Anti-phishing profile</span>
          </div>
          <div className="security-row">
            <span className="security-icon" style={{ color: "var(--green)" }}>✓</span>
            <span className="security-label">Ledger verification popup</span>
          </div>
        </div>

          </div>{/* end dashboard-right */}
        </div>
      )}

      {/* ── Ledger Verification Popup ── */}
      {showLedgerVerify && (
        <div className="ledger-verify-overlay" onClick={() => setShowLedgerVerify(false)}>
          <div className="ledger-verify-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ledger-verify-header">
              <span className="ledger-verify-icon">🔒</span>
              <span>Verify on Your Ledger</span>
            </div>
            <div className="ledger-verify-desc">
              Your Ledger device will display each field below.
              <strong> Verify every field matches exactly</strong> before pressing Approve.
            </div>

            {ledgerVerifyType === "send" && (
              <div className="ledger-verify-fields">
                <div className="ledger-verify-field">
                  <span className="ledger-verify-label">Chain</span>
                  <span className="ledger-verify-value">{network === "mainnet" ? "coreum-mainnet-1" : "coreum-testnet-1"}</span>
                </div>
                <div className="ledger-verify-field">
                  <span className="ledger-verify-label">From</span>
                  <span className="ledger-verify-value">{ledger?.address}</span>
                </div>
                <div className="ledger-verify-field">
                  <span className="ledger-verify-label">To</span>
                  <span className="ledger-verify-value">{recipient}</span>
                </div>
                <div className="ledger-verify-field">
                  <span className="ledger-verify-label">Amount</span>
                  <span className="ledger-verify-value highlight">{amount} CORE</span>
                </div>
                <div className="ledger-verify-field">
                  <span className="ledger-verify-label">Fee</span>
                  <span className="ledger-verify-value">0.05 CORE</span>
                </div>
                <div className="ledger-verify-field">
                  <span className="ledger-verify-label">Memo</span>
                  <span className="ledger-verify-value">Sent via TX Web Wallet</span>
                </div>
              </div>
            )}

            {(ledgerVerifyType === "delegate" || ledgerVerifyType === "undelegate") && (
              <div className="ledger-verify-fields">
                <div className="ledger-verify-field">
                  <span className="ledger-verify-label">Type</span>
                  <span className="ledger-verify-value">{ledgerVerifyType === "delegate" ? "Delegate (Stake)" : "Undelegate (Unstake)"}</span>
                </div>
                <div className="ledger-verify-field">
                  <span className="ledger-verify-label">Delegator</span>
                  <span className="ledger-verify-value">{ledger?.address}</span>
                </div>
                <div className="ledger-verify-field">
                  <span className="ledger-verify-label">Validator</span>
                  <span className="ledger-verify-value" style={{ fontSize: ".65rem" }}>
                    {validators.find((v) => v.operatorAddress === selectedValidator)?.moniker || selectedValidator}
                  </span>
                </div>
                <div className="ledger-verify-field">
                  <span className="ledger-verify-label">Amount</span>
                  <span className="ledger-verify-value highlight">{stakeAmount} CORE</span>
                </div>
                <div className="ledger-verify-field">
                  <span className="ledger-verify-label">Fee</span>
                  <span className="ledger-verify-value">0.05 CORE</span>
                </div>
              </div>
            )}

            {ledgerVerifyType === "claim" && (
              <div className="ledger-verify-fields">
                <div className="ledger-verify-field">
                  <span className="ledger-verify-label">Type</span>
                  <span className="ledger-verify-value">Withdraw Rewards</span>
                </div>
                <div className="ledger-verify-field">
                  <span className="ledger-verify-label">Delegator</span>
                  <span className="ledger-verify-value">{ledger?.address}</span>
                </div>
                <div className="ledger-verify-field">
                  <span className="ledger-verify-label">Validator</span>
                  <span className="ledger-verify-value" style={{ fontSize: ".65rem" }}>
                    {validators.find((v) => v.operatorAddress === ledgerVerifyValidator)?.moniker || ledgerVerifyValidator}
                  </span>
                </div>
                <div className="ledger-verify-field">
                  <span className="ledger-verify-label">Fee</span>
                  <span className="ledger-verify-value">0.05 CORE</span>
                </div>
              </div>
            )}

            <div className="ledger-verify-warning">
              If ANY field does not match, press <strong>REJECT</strong> on your Ledger device.
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-outline" onClick={() => setShowLedgerVerify(false)} style={{ flex: 1 }}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleLedgerVerifyProceed}
                style={{ flex: 1, background: `linear-gradient(135deg, ${profile.accentColor}, #059669)` }}
              >
                Proceed to Sign
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Debug Toggle */}
      <div style={{ textAlign: "center", marginTop: 8 }}>
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

      {/* Build Verification Badge */}
      <div className="build-badge">
        <div className="build-badge-header">
          <span className="build-badge-icon">&#x1f512;</span>
          <span className="build-badge-title">Open Source Verified Build</span>
        </div>
        <div className="build-badge-rows">
          <div className="build-badge-row">
            <span className="build-badge-label">Commit</span>
            <a
              className="build-badge-value"
              href={`${BUILD_INFO.repoUrl}/commit/${BUILD_INFO.commit}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {BUILD_INFO.commitShort}{BUILD_INFO.dirty ? " (dirty)" : ""}
            </a>
          </div>
          <div className="build-badge-row">
            <span className="build-badge-label">Branch</span>
            <span className="build-badge-value">{BUILD_INFO.branch}</span>
          </div>
          <div className="build-badge-row">
            <span className="build-badge-label">Built</span>
            <span className="build-badge-value">{new Date(BUILD_INFO.buildTime).toLocaleString()}</span>
          </div>
        </div>
        <div className="build-badge-verify">
          <a href={BUILD_INFO.repoUrl} target="_blank" rel="noopener noreferrer">
            Verify: clone repo &rarr; npm run build &rarr; compare hash
          </a>
        </div>
      </div>

      {/* Footer */}
      <div className="footer">
        <div>Powered by <a href="https://solomentelabs.com" target="_blank">TXAI</a> &bull; Built on TX (Coreum) &bull; <a href={BUILD_INFO.repoUrl} target="_blank">Source Code</a></div>
        <button className="btn-link" onClick={handleResetProfile} style={{ marginTop: 6, fontSize: ".6rem", color: "var(--muted)" }}>
          Reset Anti-Phishing Profile
        </button>
      </div>
    </>
  );
}

export default App;
