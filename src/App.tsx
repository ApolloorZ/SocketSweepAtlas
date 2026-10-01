import { useCallback, useEffect, useRef, useState } from "react";
import { callBackend, isMockMode } from "./backend";
import { EmptyScanScreen, ResultView } from "./ResultView";
import { DevicePanel } from "./DevicePanel";
import { SettingsPanel } from "./SettingsPanel";
import { useSettings } from "./settings";
import { addNode, findNode, removeNode } from "./tree";
import { formatBytes, formatNumber } from "./format";
import { I18nContext, say, useI18n, useI18nValue, type Params } from "./i18n";
import type { AppPhase, Capacity, FlowError, ScanResponse, Toast } from "./types";
import "./App.css";

// ── 排障建议 / troubleshooting ──────────────────────────────────────────────
// adb and the Rust layer speak English (or return `E#codes`), so the recognition
// below is language-neutral: it only ever picks which wording to show.

interface Trouble {
  match: RegExp;
  /** Keys into the hint section; each is translated where it is drawn. */
  hints: string[];
}

const TROUBLE: Trouble[] = [
  {
    match: /unauthoris|unauthoriz|E#unauthorized/i,
    hints: ["hint.allowUsb"],
  },
  {
    match: /no android device|no devices|E#no_usb_device|E#no_device/i,
    hints: ["hint.pickDevice", "hint.cable", "hint.devOptionsUnlock", "hint.usbDebugOn"],
  },
  {
    match: /局域网|无线调试|pairing|mdns|E#pair|E#connect/i,
    hints: ["hint.wirelessDebugPage", "hint.sameWifi", "hint.useCable"],
  },
  {
    match: /timed out|cannot connect to daemon|permission denied|E#timeout|E#daemon/i,
    hints: ["hint.miuiSecure", "hint.samsungBlock", "hint.usbModeFiles"],
  },
];

function hintsFor(message: string): string[] {
  return TROUBLE.find((entry) => entry.match.test(message))?.hints ?? [];
}

/** The folder the phone-side scanner walks. One place to change when the scan
 *  root becomes configurable. */
const SCAN_ROOT = "/sdcard";

// ── Icons ───────────────────────────────────────────────────────────────────

function IconChevron({ open, className = "" }: { open: boolean; className?: string }) {
  return (
    <svg className={`transition-transform duration-200 ${open ? "rotate-90" : ""} ${className}`} width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

function IconUsb() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22v-8m0 0V6m0 8l4-2v-2m-4 4l-4-2v-2"/>
      <circle cx="12" cy="4" r="2"/>
      <circle cx="8" cy="10" r="1"/>
      <rect x="15" y="9" width="2" height="2" rx="0.5"/>
    </svg>
  );
}

function IconWifi() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 8.5a15 15 0 0 1 19 0" />
      <path d="M5.5 12.2a10.5 10.5 0 0 1 13 0" />
      <path d="M8.5 15.9a6 6 0 0 1 7 0" />
      <circle cx="12" cy="19.5" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function Spinner({ size = 20, className = "" }: { size?: number; className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" opacity="0.2"/>
      <path d="M12 2a10 10 0 019.95 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  );
}

// ── Toast ───────────────────────────────────────────────────────────────────

let toastId = 0;

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  const { t } = useI18n();
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm" id="toast-container">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`
            ${toast.exiting ? "animate-toast-out" : "animate-toast-in"}
            flex items-start gap-3 px-4 py-3 rounded-lg border shadow-xl cursor-pointer backdrop-blur-md
            ${toast.type === "error"
              ? "bg-red-950/80 border-red-800/50 text-red-200"
              : toast.type === "success"
              ? "bg-emerald-950/80 border-emerald-800/50 text-emerald-200"
              : "bg-zinc-800/80 border-zinc-700/50 text-zinc-200"
            }
          `}
          onClick={() => onDismiss(toast.id)}
        >
          <span className="mt-0.5 text-base">{toast.type === "error" ? "✕" : toast.type === "success" ? "✓" : "ℹ"}</span>
          <p className="text-sm leading-relaxed flex-1">{say(t, toast.message, toast.params)}</p>
        </div>
      ))}
    </div>
  );
}

// ── Terminal log (developer detail, collapsed by default) ───────────────────

/** Kept as written so a line already on screen can be re-worded when the
 *  language changes, instead of being frozen in whichever one typed it. */
interface LogEntry {
  at: string;
  text: string;
  params?: Params;
}

function TerminalLog({ logs }: { logs: LogEntry[] }) {
  const { t } = useI18n();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="h-40 border-t border-zinc-800 bg-zinc-950 px-4 py-2 font-mono text-[11px] text-zinc-400 overflow-y-auto">
      {logs.map((log, i) => (
        <div key={i} className="mb-0.5 break-all">
          <span className="text-accent-500 mr-2">❯</span>
          <span className="text-zinc-600 mr-2">{log.at}</span>
          {say(t, log.text, log.params)}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

// ── Step progress ───────────────────────────────────────────────────────────

type StepState = "pending" | "active" | "done" | "error";

interface Step {
  key: string;
  state: StepState;
}

type ConnectMode = "usb" | "wireless";

const USB_STEPS: Step[] = [
  { key: "step.checkTools", state: "pending" },
  { key: "step.startDaemonUsb", state: "pending" },
  { key: "step.scan", state: "pending" },
  { key: "step.organise", state: "pending" },
];

const WIRELESS_STEPS: Step[] = [
  { key: "step.checkTools", state: "pending" },
  { key: "step.findPhone", state: "pending" },
  { key: "step.startDaemonWireless", state: "pending" },
  { key: "step.scan", state: "pending" },
  { key: "step.organise", state: "pending" },
];

const stepsFor = (mode: ConnectMode): Step[] =>
  (mode === "usb" ? USB_STEPS : WIRELESS_STEPS).map((s) => ({ ...s }));

function StepList({ steps }: { steps: Step[] }) {
  const { t } = useI18n();
  const marks: Record<StepState, string> = { pending: "○", active: "◐", done: "●", error: "✕" };
  const colors: Record<StepState, string> = {
    pending: "text-zinc-600",
    active: "text-accent-400",
    done: "text-emerald-500",
    error: "text-danger-400",
  };
  return (
    <ul className="flex flex-col gap-1.5 w-full max-w-xs">
      {steps.map((s, i) => (
        <li key={i} className="flex items-center gap-2.5 text-sm">
          <span className={`w-4 text-center ${colors[s.state]} ${s.state === "active" ? "animate-pulse" : ""}`}>{marks[s.state]}</span>
          <span className={s.state === "pending" ? "text-zinc-600" : "text-zinc-300"}>{t(s.key)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Wall-clock since the flow started, worded for the language in use. */
function Elapsed({ ms }: { ms: number }) {
  const { t } = useI18n();
  const total = ms / 1000;
  return (
    <>
      {total < 60
        ? t("time.seconds", { n: total.toFixed(1) })
        : t("time.minSec", { m: Math.floor(total / 60), s: Math.round(total % 60) })}
    </>
  );
}

function CancelButton({ onCancel }: { onCancel: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        onClick={onCancel}
        className="px-4 py-1.5 rounded-lg text-xs font-medium text-zinc-400 border border-zinc-700/60 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
      >
        {t("connect.cancelWait")}
      </button>
      <span className="text-[11px] text-zinc-600">{t("connect.cancelWaitNote")}</span>
    </div>
  );
}

// ── Persistent error card ───────────────────────────────────────────────────

function ErrorCard({
  titleKey,
  message,
  params,
  hints,
  onRetry,
  retryKey = "common.retry",
  onDismiss,
  secondaryKey,
  onSecondary,
}: {
  titleKey: string;
  /** Whatever came back — a dictionary key, an `E#code`, or raw adb text. */
  message: string;
  params?: Params;
  hints: string[];
  onRetry: () => void;
  retryKey?: string;
  onDismiss?: () => void;
  secondaryKey?: string;
  onSecondary?: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="w-full max-w-md rounded-xl border border-danger-500/40 bg-danger-500/5 p-4 animate-fade-in-up">
      <div className="flex items-start gap-2.5">
        {onDismiss ? (
          <button
            onClick={onDismiss}
            aria-label={t("common.close")}
            className="mt-0.5 w-5 h-5 -ml-1 flex items-center justify-center rounded text-danger-400 hover:bg-danger-500/15 cursor-pointer text-sm"
          >
            ✕
          </button>
        ) : (
          <span className="mt-0.5 text-danger-400 text-sm">✕</span>
        )}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-danger-400">{t(titleKey)}</h3>
          <p className="mt-1 text-sm text-zinc-300 leading-relaxed break-words">{say(t, message, params)}</p>
          {hints.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1.5">
              {hints.map((h, i) => (
                <li key={i} className="text-xs text-zinc-500 leading-relaxed flex gap-2">
                  <span className="text-zinc-700">·</span>
                  <span>{say(t, h)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={onRetry}
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-gradient-to-r from-accent-600 to-accent-500 text-white hover:from-accent-500 hover:to-accent-400 transition-colors cursor-pointer"
            >
              {t(retryKey)}
            </button>
            {secondaryKey && onSecondary && (
              <button
                onClick={onSecondary}
                className="px-4 py-2 rounded-lg text-xs font-medium text-zinc-300 border border-zinc-700 hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                {t(secondaryKey)}
              </button>
            )}
            {onDismiss && (
              <button
                onClick={onDismiss}
                className="px-3 py-2 rounded-lg text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
              >
                {t("common.known")}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Setup / progress screens ────────────────────────────────────────────────

function SetupScreen({
  mode,
  onConnect,
  loading,
  steps,
  elapsedMs,
  flowError,
  onCancel,
  onDismissError,
  target,
  onOpenDevices,
}: {
  mode: ConnectMode;
  onConnect: (mode: ConnectMode) => void;
  loading: boolean;
  steps: Step[];
  elapsedMs: number;
  flowError: FlowError | null;
  onCancel: () => void;
  onDismissError: () => void;
  target: string | null;
  onOpenDevices: () => void;
}) {
  const { t } = useI18n();
  const targetLabel = !target
    ? t("connect.targetAuto")
    : target.includes("_adb-tls-connect")
      ? t("connect.targetWireless", { host: target.replace(/^adb-/, "").split(".")[0] })
      : target;

  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-7 px-6 animate-fade-in-up overflow-y-auto">
      <div className="flex flex-col items-center gap-5">
        <div className={`
          w-20 h-20 rounded-2xl bg-gradient-to-br from-accent-500/20 to-accent-700/10
          border border-accent-500/20 flex items-center justify-center
          ${loading ? "animate-pulse-glow" : ""}
        `}>
          <span className="text-accent-400">{mode === "usb" ? <IconUsb /> : <IconWifi />}</span>
        </div>

        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-zinc-100 to-zinc-400 bg-clip-text text-transparent">
            SocketSweep
          </h1>
          <p className="mt-1.5 text-sm text-zinc-500 leading-relaxed">
            {t("connect.tagline")}
            <br />
            <span className="text-zinc-600">{t("connect.tagline2")}</span>
          </p>
        </div>
      </div>

      {loading ? (
        <>
          <StepList steps={steps} />
          <div className="flex items-center gap-2 text-xs font-mono text-zinc-500">
            <Spinner size={14} className="text-accent-400" />
            {t("connect.elapsedPrefix")} <Elapsed ms={elapsedMs} />
          </div>
          <CancelButton onCancel={onCancel} />
        </>
      ) : (
        <>
          {flowError && (
            <ErrorCard
              titleKey="connect.failed"
              message={flowError.message}
              params={flowError.params}
              hints={flowError.hints}
              onRetry={() => onConnect(mode)}
              retryKey="connect.retry"
              onDismiss={onDismissError}
              secondaryKey="connect.otherDevice"
              onSecondary={onOpenDevices}
            />
          )}

          {/* Two ways in. Each one runs the whole flow on its own. */}
          <div className="grid grid-cols-2 gap-3 w-full max-w-md">
            {(
              [
                { key: "usb" as const, icon: <IconUsb />, titleKey: "connect.usb", noteKey: "connect.usbNote" },
                { key: "wireless" as const, icon: <IconWifi />, titleKey: "connect.wireless", noteKey: "connect.wirelessNote" },
              ]
            ).map((entry) => (
              <button
                key={entry.key}
                id={`btn-${entry.key}`}
                onClick={() => onConnect(entry.key)}
                className={`flex flex-col items-center gap-2 px-4 py-5 rounded-xl border text-center cursor-pointer transition-all duration-300 hover:-translate-y-0.5 ${
                  mode === entry.key
                    ? "border-accent-500/50 bg-accent-500/10 hover:shadow-lg hover:shadow-accent-500/15"
                    : "border-zinc-800 bg-zinc-900/60 hover:border-zinc-700"
                }`}
              >
                <span className="text-accent-400">{entry.icon}</span>
                <span className="text-sm font-semibold text-zinc-100">{t(entry.titleKey)}</span>
                <span className="text-[11px] text-zinc-500 leading-snug">{t(entry.noteKey)}</span>
              </button>
            ))}
          </div>

          <div className="flex flex-col items-center gap-1.5 text-xs text-zinc-600">
            <p>· {t("connect.noteNoApp")}</p>
            <p>· {t("connect.notePairOnce")}</p>
          </div>

          <button
            id="btn-devices"
            onClick={onOpenDevices}
            className="text-xs text-zinc-500 hover:text-accent-400 transition-colors cursor-pointer underline underline-offset-2 decoration-zinc-700 hover:decoration-accent-500"
          >
            {t("connect.manageDevices", { target: targetLabel })}
          </button>
        </>
      )}
    </div>
  );
}

function ScanningScreen({ steps, elapsedMs, onCancel }: { steps: Step[]; elapsedMs: number; onCancel: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center flex-1 gap-6 px-6 animate-fade-in-up">
      <div className="relative w-28 h-28">
        <div className="absolute inset-0 rounded-full border-2 border-accent-500/20" />
        <svg className="absolute inset-0 animate-spin" style={{ animationDuration: "2s" }} viewBox="0 0 128 128">
          <circle cx="64" cy="64" r="62" fill="none" stroke="url(#scanGrad)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="120 280" />
          <defs>
            <linearGradient id="scanGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="oklch(0.60 0.18 180)" />
              <stop offset="100%" stopColor="oklch(0.60 0.18 180 / 0)" />
            </linearGradient>
          </defs>
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-14 h-14 rounded-xl bg-accent-500/10 border border-accent-500/20 flex items-center justify-center scan-shimmer">
            <span className="text-accent-400 text-xl">⚡</span>
          </div>
        </div>
      </div>

      <div className="text-center">
        <h2 className="text-lg font-semibold text-zinc-200">{t("scanning.title")}</h2>
        <p className="mt-1 text-xs text-zinc-600">{t("scanning.note")}</p>
      </div>

      <StepList steps={steps} />
      <div className="text-sm font-mono text-accent-400">{t("connect.elapsedPrefix")} <Elapsed ms={elapsedMs} /></div>
      <CancelButton onCancel={onCancel} />
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────

function App() {
  const [phase, setPhase] = useState<AppPhase>("setup");
  const [scanData, setScanData] = useState<ScanResponse | null>(null);
  const [capacity, setCapacity] = useState<Capacity | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const { settings, patch: patchSettings } = useSettings();
  const i18n = useI18nValue(settings.lang);
  const [logsOpen, setLogsOpen] = useState(settings.logsOpen);
  const [steps, setSteps] = useState<Step[]>(() => stepsFor("usb"));
  const [elapsedMs, setElapsedMs] = useState(0);
  const [flowError, setFlowError] = useState<FlowError | null>(null);
  const [target, setTarget] = useState<string | null>(() => localStorage.getItem("ss-target"));
  const [mode, setMode] = useState<ConnectMode>("usb");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // null = closed; "pair" is opened by the wireless flow when Android still needs
  // proof of physical presence, "manage" is the user opening it themselves.
  const [panel, setPanel] = useState<{ intent: "manage" | "pair"; endpoint: string | null } | null>(null);

  useEffect(() => {
    if (target) localStorage.setItem("ss-target", target);
    else localStorage.removeItem("ss-target");
  }, [target]);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  // Screen readers and `Intl` both read this, so it has to follow the choice.
  useEffect(() => {
    document.documentElement.lang = settings.lang === "zh" ? "zh-CN" : "en";
  }, [settings.lang]);

  // The two folders live in Rust, which is where every file operation happens.
  // The settings page reports failures itself; this only keeps both in step.
  useEffect(() => {
    if (isMockMode) return;
    callBackend<string>("set_paths", {
      cache: settings.cachePath,
      download: settings.downloadPath,
      clearOnExit: settings.clearCacheOnExit,
    }).catch(() => undefined);
  }, [settings.cachePath, settings.downloadPath, settings.clearCacheOnExit]);

  const timerRefs = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const runIdRef = useRef(0);
  const activeStepRef = useRef<string>("");
  const scanDataRef = useRef<ScanResponse | null>(null);

  useEffect(() => { scanDataRef.current = scanData; }, [scanData]);

  const addLog = useCallback((text: string, params?: Params) => {
    setLogs((prev) => [...prev.slice(-199), { at: new Date().toLocaleTimeString(), text, params }]);
  }, []);

  useEffect(() => {
    if (phase !== "connecting" && phase !== "scanning") return;
    const started = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => setElapsedMs(Date.now() - started), 100);
    return () => clearInterval(id);
  }, [phase]);

  const pushToast = useCallback((message: string, type: Toast["type"] = "error", params?: Params) => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type, params }]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 300);
    }, 5000);
    timerRefs.current.set(id, timer);
  }, []);

  const dismissToast = useCallback((id: number) => {
    const timer = timerRefs.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timerRefs.current.delete(id);
    }
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 300);
  }, []);

  /** The capacity strip is a `df` snapshot taken at connect time, so anything
   *  that changes the phone's usage has to ask again or it quietly keeps lying. */
  const refreshCapacity = useCallback(async () => {
    try {
      setCapacity(JSON.parse(await callBackend<string>("get_storage_info")) as Capacity);
    } catch (err: unknown) {
      addLog(`[CAPACITY] ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [addLog]);

  const markStep = useCallback((key: string, state: StepState) => {
    activeStepRef.current = key;
    setSteps((prev) => prev.map((s) => (s.key === key ? { ...s, state } : s)));
  }, []);

  /** The raw text is kept so the card can be re-worded after a language change. */
  const failFlow = useCallback((message: string) => {
    if (activeStepRef.current) markStep(activeStepRef.current, "error");
    setFlowError({ message, hints: hintsFor(message) });
    addLog("log.error", { detail: message });
  }, [markStep, addLog]);

  /// One press runs everything: find the phone, start the daemon, scan, render.
  /// For wireless, the LAN search either succeeds or hands off to the pairing
  /// panel — Android will not pair without proof the phone is physically here.
  const runFlow = useCallback(async (connectMode: ConnectMode) => {
    const runId = ++runIdRef.current;
    const stale = () => runIdRef.current !== runId;

    setMode(connectMode);
    setFlowError(null);
    setSteps(stepsFor(connectMode));
    setPhase("connecting");

    const daemonStep = connectMode === "usb" ? "step.startDaemonUsb" : "step.startDaemonWireless";

    try {
      markStep("step.checkTools", "active");
      addLog("log.checkAdb");
      const adbVersion = await callBackend<string>("check_adb");
      if (stale()) return;
      addLog(`[ADB] ${adbVersion}`);
      markStep("step.checkTools", "done");

      let serial = target;

      if (connectMode === "wireless") {
        markStep("step.findPhone", "active");
        addLog("log.findPhone");
        const found = JSON.parse(await callBackend<string>("wireless_auto_connect")) as {
          status: string;
          serial: string | null;
          pairing_endpoint: string | null;
        };
        if (stale()) return;
        if (found.status !== "connected" || !found.serial) {
          setPanel({ intent: "pair", endpoint: found.pairing_endpoint });
          setPhase("setup");
          return;
        }
        addLog("log.connectedTo", { serial: found.serial });
        serial = found.serial;
        setTarget(found.serial);
        markStep("step.findPhone", "done");
      } else {
        // Prefer the wired transport so an old wireless one cannot hijack the scan.
        const devices = JSON.parse(await callBackend<string>("list_devices")) as {
          serial: string;
          kind: string;
          status: string;
        }[];
        if (stale()) return;
        const usb = devices.find((d) => d.kind === "usb" && d.status === "device");
        if (!usb) throw new Error("E#no_usb_device");
        serial = usb.serial;
        setTarget(usb.serial);
      }

      markStep(daemonStep, "active");
      addLog("log.pushDaemon");
      const started = await callBackend<string>("init_daemon", serial ? { serial } : undefined);
      if (stale()) return;
      // A wireless phone re-registers under a new name whenever its IP or debug
      // port moves, so pin whichever serial the backend really drove.
      const usedSerial = (JSON.parse(started) as { serial?: string }).serial;
      if (usedSerial && usedSerial !== target) setTarget(usedSerial);
      addLog("log.daemonAlive");
      markStep(daemonStep, "done");

      // Capacity is advisory: a failure here must not block the scan.
      try {
        const raw = await callBackend<string>("get_storage_info");
        if (!stale()) setCapacity(JSON.parse(raw) as Capacity);
      } catch (err: unknown) {
        addLog(`[CAPACITY] ${err instanceof Error ? err.message : String(err)}`);
      }

      setPhase("scanning");
      markStep("step.scan", "active");
      addLog("log.scanRequest", { root: SCAN_ROOT });
      const requestAt = performance.now();
      const raw = await callBackend<string>("run_scan", { path: SCAN_ROOT });
      if (stale()) return;
      // Where the wait goes: the round trip through Rust and adb, then the
      // browser's own parse. The phone's share is in `scan_time_ms`.
      const ipcMs = Math.round(performance.now() - requestAt);
      markStep("step.scan", "done");

      markStep("step.organise", "active");
      const parsed: ScanResponse = JSON.parse(raw);
      const parseMs = Math.round(performance.now() - requestAt) - ipcMs;
      if (parsed.status !== "ok") throw new Error(`E#scan_status#${parsed.status || "?"}`);
      if (stale()) return;
      markStep("step.organise", "done");

      setScanData(parsed);
      setPhase("result");
      requestAnimationFrame(() => {
        addLog("log.scanTiming", {
          ipc: ipcMs,
          parse: parseMs,
          frame: Math.round(performance.now() - requestAt),
          phone: parsed.scan_time_ms,
          size: (raw.length / 1048576).toFixed(1),
        });
      });
      addLog("log.scanDone", { files: formatNumber(parsed.total_files), ms: parsed.scan_time_ms });
      // The phone measures its own phases; a daemon too old to report them just
      // stays quiet rather than printing a line of zeros.
      if (parsed.traverse_ms !== undefined) {
        addLog("log.scanPhases", {
          traverse: parsed.traverse_ms,
          sort: parsed.sort_ms ?? 0,
          write: parsed.serialize_ms ?? 0,
          send: parsed.send_ms ?? 0,
          wire: ((parsed.bytes_sent ?? 0) / 1048576).toFixed(1),
        });
      }
    } catch (err: unknown) {
      if (stale()) return;
      failFlow(err instanceof Error ? err.message : String(err));
      setPhase("setup");
    }
  }, [addLog, failFlow, markStep, target]);

  const handleRescan = useCallback(async () => {
    const runId = ++runIdRef.current;
    const stale = () => runIdRef.current !== runId;
    const rescanSteps: Step[] = [
      { key: "step.scan", state: "active" },
      { key: "step.organise", state: "pending" },
    ];

    setFlowError(null);
    setSteps(rescanSteps);
    setPhase("scanning");
    addLog("log.rescan", { root: SCAN_ROOT });
    try {
      const raw = await callBackend<string>("run_scan", { path: SCAN_ROOT });
      if (stale()) return;
      setSteps(rescanSteps.map((s, i) => ({ ...s, state: (i === 0 ? "done" : "active") as StepState })));
      const parsed: ScanResponse = JSON.parse(raw);
      if (stale()) return;
      setScanData(parsed);
      setPhase("result");
      addLog("log.scanDone", { files: formatNumber(parsed.total_files), ms: parsed.scan_time_ms });
      // The phone measures its own phases; a daemon too old to report them just
      // stays quiet rather than printing a line of zeros.
      if (parsed.traverse_ms !== undefined) {
        addLog("log.scanPhases", {
          traverse: parsed.traverse_ms,
          sort: parsed.sort_ms ?? 0,
          write: parsed.serialize_ms ?? 0,
          send: parsed.send_ms ?? 0,
          wire: ((parsed.bytes_sent ?? 0) / 1048576).toFixed(1),
        });
      }
    } catch (err: unknown) {
      if (stale()) return;
      const message = err instanceof Error ? err.message : String(err);
      setSteps(rescanSteps.map((s, i) => ({ ...s, state: (i === 0 ? "error" : s.state) as StepState })));
      setFlowError({ message, hints: hintsFor(message) });
      addLog("log.error", { detail: message });
      setPhase("result");
    }
  }, [addLog]);

  const handleCancelWait = useCallback(() => {
    runIdRef.current++;
    addLog("log.cancelWait");
    pushToast("toast.waitCancelled", "info");
    setSteps(stepsFor(mode));
    setPhase(scanData ? "result" : "setup");
  }, [addLog, pushToast, scanData, mode]);

  // An upload changes the phone, so the tree has to change with it: insert the
  // file and grow every ancestor, otherwise the numbers shown are a lie.
  const handleUploaded = useCallback((items: { name: string; bytes: number }[], dirPath: string) => {
    const base = scanDataRef.current;
    if (!base) return;
    const dir = dirPath.replace(/\/+$/, "");
    const now = Math.floor(Date.now() / 1000);
    let tree = base.tree;
    let added = 0;
    let bytes = 0;

    for (const item of items) {
      const result = addNode(tree, dir, {
        name: item.name,
        path: `${dir}/${item.name}`,
        type: "file",
        size: item.bytes,
        mtime: now,
      });
      if (!result.added) continue;
      tree = result.root;
      added += 1;
      bytes += item.bytes;
    }
    if (added === 0) return;

    setScanData({
      ...base,
      tree,
      total_files: base.total_files + added,
      total_size: base.total_size + bytes,
    });
    pushToast("toast.uploaded", "success", { count: added, size: formatBytes(bytes) });
    void refreshCapacity();
  }, [pushToast, refreshCapacity]);

  // A move keeps the same bytes, so the totals do not change — but the source
  // branch shrinks and the destination branch grows, or the treemap lies.
  const handleMovePaths = useCallback(async (paths: string[], dest: string) => {
    const base = scanDataRef.current;
    if (!base || paths.length === 0) return;
    addLog("log.moveStart", { count: paths.length, dest });
    try {
      const raw = await callBackend<string>("move_items", { paths, dest });
      const result = JSON.parse(raw) as {
        moved: { from: string; to: string; name: string }[];
        failed: string[];
      };
      let tree = base.tree;
      for (const item of result.moved) {
        const node = findNode(tree, item.from);
        const removed = removeNode(tree, item.from);
        if (!node || !removed.removed) continue;
        tree = removed.root;
        const added = addNode(tree, dest, { ...node, path: item.to, name: item.name });
        if (added.added) tree = added.root;
      }
      if (result.moved.length > 0) setScanData({ ...base, tree });
      if (result.moved.length > 0) pushToast("toast.moved", "success", { count: result.moved.length });
      if (result.failed.length > 0) {
        setFlowError({
          message: "err.moveFailed",
          params: { count: result.failed.length },
          hints: result.failed.slice(0, 6),
        });
      }
      addLog("log.moveDone", { ok: result.moved.length, failed: result.failed.length });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setFlowError({ message, hints: hintsFor(message) });
      addLog("log.error", { detail: message });
    }
  }, [addLog, pushToast]);

  const handleDisconnect = useCallback(async () => {
    runIdRef.current++;
    addLog("log.stopDaemon");
    try {
      await callBackend<string>("stop_daemon");
      pushToast("toast.disconnected", "info");
      addLog("log.daemonStopped");
    } catch {
      addLog("log.daemonWasIdle");
    }
    setScanData(null);
    setCapacity(null);
    setFlowError(null);
    setPhase("setup");
  }, [addLog, pushToast]);

  const handleDeletePaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    const base = scanDataRef.current;
    addLog("log.deleteStart", { count: paths.length });

    let tree = base?.tree ?? null;
    let freed = 0;
    let files = 0;
    let dirs = 0;
    const failed: string[] = [];

    for (const path of paths) {
      if (base && path === base.tree.path) {
        failed.push("err.scanRoot");
        continue;
      }
      try {
        const parsed = JSON.parse(await callBackend<string>("delete_item", { path }));
        if (parsed.status !== "ok") {
          failed.push(path);
          continue;
        }
        if (tree) {
          const result = removeNode(tree, path);
          if (result.removed) {
            tree = result.root;
            freed += result.size;
            files += result.files;
            dirs += result.dirs;
          }
        }
      } catch (err: unknown) {
        failed.push(path);
        addLog("log.error", { detail: err instanceof Error ? err.message : String(err) });
      }
    }

    if (base && tree && freed > 0) {
      setScanData({
        ...base,
        tree,
        total_files: Math.max(0, base.total_files - files),
        total_dirs: Math.max(0, base.total_dirs - dirs),
        total_size: Math.max(0, base.total_size - freed),
      });
    }

    const okCount = paths.length - failed.length;
    if (okCount > 0) pushToast("toast.deleted", "success", { count: okCount, size: formatBytes(freed) });

    // Gigabytes just went away; the strip has to be asked again.
    if (freed > 0) await refreshCapacity();
    if (failed.length > 0) {
      setFlowError({
        message: "err.deleteFailed",
        params: { list: `${failed.slice(0, 3).join(", ")}${failed.length > 3 ? " …" : ""}` },
        hints: ["hint.deleteInUse"],
      });
    }
    addLog("log.deleteDone", { ok: okCount, failed: failed.length, size: formatBytes(freed) });
  }, [addLog, pushToast, refreshCapacity]);

  useEffect(() => {
    const timers = timerRefs.current;
    return () => { timers.forEach((t) => clearTimeout(t)); };
  }, []);

  return (
    <I18nContext.Provider value={i18n}>
      <div className="h-screen flex flex-col bg-surface-0 overflow-hidden">
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />

        {isMockMode && (
          <div className="shrink-0 bg-amber-500/15 border-b border-amber-500/30 text-amber-300 text-[11px] px-3 py-1 font-mono">
            {i18n.t("app.mockBanner")}
          </div>
        )}

        <div className="flex-1 flex flex-col min-h-0">
          {(phase === "setup" || phase === "connecting") && (
            <SetupScreen
              mode={mode}
              onConnect={(next) => void runFlow(next)}
              loading={phase === "connecting"}
              steps={steps}
              elapsedMs={elapsedMs}
              flowError={flowError}
              onCancel={handleCancelWait}
              onDismissError={() => setFlowError(null)}
              target={target}
              onOpenDevices={() => setPanel({ intent: "manage", endpoint: null })}
            />
          )}
          {phase === "scanning" && <ScanningScreen steps={steps} elapsedMs={elapsedMs} onCancel={handleCancelWait} />}
          {phase === "result" && scanData && scanData.total_files === 0 && (
            <div className="flex flex-col flex-1 min-h-0">
              <EmptyScanScreen onRescan={handleRescan} onDisconnect={handleDisconnect} />
            </div>
          )}
          {phase === "result" && scanData && scanData.total_files > 0 && (
            <ResultView
              data={scanData}
              capacity={capacity}
              onRescan={handleRescan}
              onDisconnect={handleDisconnect}
              onDeletePaths={handleDeletePaths}
              onMovePaths={handleMovePaths}
              notify={(message, params) => pushToast(message, "error", params)}
              onUploaded={handleUploaded}
              flowError={flowError}
              onDismissError={() => setFlowError(null)}
              settings={settings}
            />
          )}
        </div>

        <div className="shrink-0 border-t border-zinc-800/80 bg-zinc-950">
          <div className="flex items-center gap-3 px-4 py-1.5">
            <button
              onClick={() => {
                const next = !logsOpen;
                setLogsOpen(next);
                patchSettings({ logsOpen: next });
              }}
              className="flex items-center gap-2 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
            >
              <IconChevron open={logsOpen} />
              <span>{i18n.t("app.logToggle")}</span>
              {logs.length > 0 && <span className="text-zinc-700">({i18n.t("app.logCount", { count: logs.length })})</span>}
            </button>
            <div className="ml-auto flex items-center gap-3">
              {flowError && <span className="text-[11px] text-danger-400">{i18n.t("app.lastError")}</span>}
              <button
                id="btn-settings"
                onClick={() => setSettingsOpen(true)}
                title={i18n.t("app.settings")}
                aria-label={i18n.t("app.settings")}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
              >
                <IconGear />
                {i18n.t("app.settings")}
              </button>
            </div>
          </div>
          {logsOpen && <TerminalLog logs={logs} />}
        </div>

        {settingsOpen && (
          <SettingsPanel
            settings={settings}
            onPatch={patchSettings}
            target={target}
            onResetTarget={() => setTarget(null)}
            onOpenDevices={() => setPanel({ intent: "manage", endpoint: null })}
            onClose={() => setSettingsOpen(false)}
          />
        )}

        {panel && (
          <DevicePanel
            target={target}
            intent={panel.intent}
            pairingEndpoint={panel.endpoint}
            onPickTarget={(serial) => { setTarget(serial); setFlowError(null); }}
            onConnected={(serial) => { setPanel(null); setTarget(serial); void runFlow("wireless"); }}
            onClose={() => setPanel(null)}
          />
        )}
      </div>
    </I18nContext.Provider>
  );
}

export default App;
