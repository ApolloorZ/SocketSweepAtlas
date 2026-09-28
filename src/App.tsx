import { useCallback, useEffect, useRef, useState } from "react";
import { callBackend, isMockMode } from "./backend";
import { EmptyScanScreen, ResultView } from "./ResultView";
import { DevicePanel } from "./DevicePanel";
import { SettingsPanel } from "./SettingsPanel";
import { useSettings } from "./settings";
import { removeNode } from "./tree";
import { formatBytes, formatNumber } from "./format";
import type { AppPhase, Capacity, ScanResponse, Toast } from "./types";
import "./App.css";

// ── 后端错误中文化与排障建议 ────────────────────────────────────────────────
// Rust 层返回的是固定几条英文错误,这里映射成中文并附上可操作的提示。

const ERROR_TRANSLATIONS: { match: string; zh: string }[] = [
  { match: "no android device detected", zh: "没有检测到手机。请用数据线连接,并在手机上允许 USB 调试。" },
  { match: "usb debugging not authorised", zh: "手机上还没有点“允许 USB 调试”。请看手机屏幕上的弹窗并选择允许。" },
  { match: "timed out", zh: "手机长时间没有响应,已超时。请重新插拔数据线后再试。" },
  { match: "cannot connect to daemon", zh: "扫描程序没能启动。断开后重新连接一次通常即可恢复。" },
  { match: "failed to read device storage capacity", zh: "读不到手机容量信息,占比会按已扫描总量估算。" },
  { match: "unable to start pairing client", zh: "配不上:请填手机「使用配对码配对设备」界面上显示的那个 IP:端口,并确认 6 位码还没过期。" },
  { match: "pairing failed", zh: "配对失败:配对码可能已过期。在手机上重新点一次「使用配对码配对设备」,再填新的码。" },
  { match: "failed to connect to", zh: "连不上:确认手机和电脑连着同一个 Wi-Fi,并且手机上的「无线调试」开关还开着。" },
  { match: "failed to execute adb", zh: "电脑端的 adb 无法运行,可能是安装不完整。" },
  { match: "not found at", zh: "程序自带的文件缺失,需要重新安装。" },
  { match: "permission denied", zh: "手机拒绝了这个操作,请检查开发者选项里的 USB 调试开关。" },
];

function translateError(message: string): string {
  const lower = message.toLowerCase();
  return ERROR_TRANSLATIONS.find((e) => lower.includes(e.match))?.zh ?? message;
}

function hintsFor(message: string): string[] {
  const lower = message.toLowerCase();
  const hints: string[] = [];
  if (lower.includes("unauthoris") || lower.includes("unauthoriz")) {
    hints.push("在手机弹窗上点“允许 USB 调试”,可以勾选“一律允许”。");
  }
  if (lower.includes("没有找到设备") || lower.includes("no android device") || lower.includes("no devices")) {
    if (lower.includes("没有找到设备")) {
      hints.push("点下方「管理设备与配对」重新选一台,或者改点「无线连接」。");
    }
    hints.push("换一根数据线 —— 有些线只能充电,不能传数据。");
    hints.push("手机:设置 → 关于手机 → 连续点“版本号”7 次,解锁开发者选项。");
    hints.push("手机:设置 → 开发者选项 → 打开“USB 调试”。");
  }
  if (lower.includes("局域网") || lower.includes("无线调试") || lower.includes("pairing") || lower.includes("mdns")) {
    hints.push("手机:开发者选项 → 无线调试 打开,并且停在这个页面别退出 —— 不少系统只在这个页面开着时才对外广播。");
    hints.push("确认手机和电脑连的是同一个 Wi-Fi,而且路由器没开「AP 隔离 / 客户端隔离」。");
    hints.push("实在找不到就改用有线连接,一根数据线就够,不受网络影响。");
  }
  if (lower.includes("timed out") || lower.includes("cannot connect to daemon") || lower.includes("permission denied")) {
    hints.push("小米 / 红米:还要打开“USB 调试(安全设置)”。");
    hints.push("三星:若 USB 调试变灰,请关闭“自动阻止”(设置 → 安全)。");
    hints.push("手机下拉通知栏,把 USB 用途从“仅充电”改成“传输文件”。");
  }
  return hints;
}

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
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm" id="toast-container">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`
            ${t.exiting ? "animate-toast-out" : "animate-toast-in"}
            flex items-start gap-3 px-4 py-3 rounded-lg border shadow-xl cursor-pointer backdrop-blur-md
            ${t.type === "error"
              ? "bg-red-950/80 border-red-800/50 text-red-200"
              : t.type === "success"
              ? "bg-emerald-950/80 border-emerald-800/50 text-emerald-200"
              : "bg-zinc-800/80 border-zinc-700/50 text-zinc-200"
            }
          `}
          onClick={() => onDismiss(t.id)}
        >
          <span className="mt-0.5 text-base">{t.type === "error" ? "✕" : t.type === "success" ? "✓" : "ℹ"}</span>
          <p className="text-sm leading-relaxed flex-1">{t.message}</p>
        </div>
      ))}
    </div>
  );
}

// ── Terminal log (developer detail, collapsed by default) ───────────────────

function TerminalLog({ logs }: { logs: string[] }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div className="h-40 border-t border-zinc-800 bg-zinc-950 px-4 py-2 font-mono text-[11px] text-zinc-400 overflow-y-auto">
      {logs.map((log, i) => (
        <div key={i} className="mb-0.5 break-all">
          <span className="text-accent-500 mr-2">❯</span>
          {log}
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}

// ── Step progress ───────────────────────────────────────────────────────────

type StepState = "pending" | "active" | "done" | "error";

interface Step {
  label: string;
  state: StepState;
}

type ConnectMode = "usb" | "wireless";

const USB_STEPS: Step[] = [
  { label: "检查电脑端组件", state: "pending" },
  { label: "连接手机并启动扫描程序", state: "pending" },
  { label: "扫描手机存储", state: "pending" },
  { label: "整理结果", state: "pending" },
];

const WIRELESS_STEPS: Step[] = [
  { label: "检查电脑端组件", state: "pending" },
  { label: "在局域网里找到手机", state: "pending" },
  { label: "启动手机上的扫描程序", state: "pending" },
  { label: "扫描手机存储", state: "pending" },
  { label: "整理结果", state: "pending" },
];

const stepsFor = (mode: ConnectMode): Step[] =>
  (mode === "usb" ? USB_STEPS : WIRELESS_STEPS).map((s) => ({ ...s }));

function StepList({ steps }: { steps: Step[] }) {
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
          <span className={s.state === "pending" ? "text-zinc-600" : "text-zinc-300"}>{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

function formatElapsed(ms: number): string {
  const total = ms / 1000;
  if (total < 60) return `${total.toFixed(1)} 秒`;
  return `${Math.floor(total / 60)} 分 ${Math.round(total % 60)} 秒`;
}

function CancelButton({ onCancel }: { onCancel: () => void }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        onClick={onCancel}
        className="px-4 py-1.5 rounded-lg text-xs font-medium text-zinc-400 border border-zinc-700/60 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
      >
        取消等待
      </button>
      <span className="text-[11px] text-zinc-600">取消后手机上的扫描仍会继续,稍后重连即可</span>
    </div>
  );
}

// ── Persistent error card ───────────────────────────────────────────────────

function ErrorCard({
  title,
  message,
  hints,
  onRetry,
  retryLabel = "重试",
  onDismiss,
  secondary,
}: {
  title: string;
  message: string;
  hints: string[];
  onRetry: () => void;
  retryLabel?: string;
  onDismiss?: () => void;
  secondary?: { label: string; onClick: () => void };
}) {
  return (
    <div className="w-full max-w-md rounded-xl border border-danger-500/40 bg-danger-500/5 p-4 animate-fade-in-up">
      <div className="flex items-start gap-2.5">
        {onDismiss ? (
          <button
            onClick={onDismiss}
            aria-label="关闭这条提示"
            className="mt-0.5 w-5 h-5 -ml-1 flex items-center justify-center rounded text-danger-400 hover:bg-danger-500/15 cursor-pointer text-sm"
          >
            ✕
          </button>
        ) : (
          <span className="mt-0.5 text-danger-400 text-sm">✕</span>
        )}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-danger-400">{title}</h3>
          <p className="mt-1 text-sm text-zinc-300 leading-relaxed break-words">{message}</p>
          {hints.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1.5">
              {hints.map((h, i) => (
                <li key={i} className="text-xs text-zinc-500 leading-relaxed flex gap-2">
                  <span className="text-zinc-700">·</span>
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={onRetry}
              className="px-4 py-2 rounded-lg text-xs font-semibold bg-gradient-to-r from-accent-600 to-accent-500 text-white hover:from-accent-500 hover:to-accent-400 transition-colors cursor-pointer"
            >
              {retryLabel}
            </button>
            {secondary && (
              <button
                onClick={secondary.onClick}
                className="px-4 py-2 rounded-lg text-xs font-medium text-zinc-300 border border-zinc-700 hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                {secondary.label}
              </button>
            )}
            {onDismiss && (
              <button
                onClick={onDismiss}
                className="px-3 py-2 rounded-lg text-xs text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
              >
                知道了
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
  targetLabel,
  onOpenDevices,
}: {
  mode: ConnectMode;
  onConnect: (mode: ConnectMode) => void;
  loading: boolean;
  steps: Step[];
  elapsedMs: number;
  flowError: { message: string; hints: string[] } | null;
  onCancel: () => void;
  onDismissError: () => void;
  targetLabel: string;
  onOpenDevices: () => void;
}) {
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
            看清手机存储里到底装了什么
            <br />
            <span className="text-zinc-600">绕开 MTP,直接读取文件系统</span>
          </p>
        </div>
      </div>

      {loading ? (
        <>
          <StepList steps={steps} />
          <div className="flex items-center gap-2 text-xs font-mono text-zinc-500">
            <Spinner size={14} className="text-accent-400" />
            已用 {formatElapsed(elapsedMs)}
          </div>
          <CancelButton onCancel={onCancel} />
        </>
      ) : (
        <>
          {flowError && (
            <ErrorCard
              title="连接失败"
              message={flowError.message}
              hints={flowError.hints}
              onRetry={() => onConnect(mode)}
              retryLabel="重新连接"
              onDismiss={onDismissError}
              secondary={{ label: "选择其他设备", onClick: onOpenDevices }}
            />
          )}

          {/* Two ways in. Each one runs the whole flow on its own. */}
          <div className="grid grid-cols-2 gap-3 w-full max-w-md">
            {(
              [
                { key: "usb" as const, icon: <IconUsb />, title: "有线连接", note: "插好数据线,开了 USB 调试就行" },
                { key: "wireless" as const, icon: <IconWifi />, title: "无线连接", note: "和电脑连同一个 Wi-Fi,不用线" },
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
                <span className="text-sm font-semibold text-zinc-100">{entry.title}</span>
                <span className="text-[11px] text-zinc-500 leading-snug">{entry.note}</span>
              </button>
            ))}
          </div>

          <div className="flex flex-col items-center gap-1.5 text-xs text-zinc-600">
            <p>· 手机不用装 App,也不需要 root</p>
            <p>· 无线第一次要配对一次,以后点一下就自动连上并开始扫描</p>
          </div>

          <button
            id="btn-devices"
            onClick={onOpenDevices}
            className="text-xs text-zinc-500 hover:text-accent-400 transition-colors cursor-pointer underline underline-offset-2 decoration-zinc-700 hover:decoration-accent-500"
          >
            目标设备:{targetLabel} · 管理设备与配对
          </button>
        </>
      )}
    </div>
  );
}

function ScanningScreen({ steps, elapsedMs, onCancel }: { steps: Step[]; elapsedMs: number; onCancel: () => void }) {
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
        <h2 className="text-lg font-semibold text-zinc-200">正在扫描手机存储</h2>
        <p className="mt-1 text-xs text-zinc-600">一般 10–60 秒,期间不要拔线</p>
      </div>

      <StepList steps={steps} />
      <div className="text-sm font-mono text-accent-400">已用 {formatElapsed(elapsedMs)}</div>
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
  const [logs, setLogs] = useState<string[]>([]);
  const { settings, patch: patchSettings } = useSettings();
  const [logsOpen, setLogsOpen] = useState(settings.logsOpen);
  const [steps, setSteps] = useState<Step[]>(() => stepsFor("usb"));
  const [elapsedMs, setElapsedMs] = useState(0);
  const [flowError, setFlowError] = useState<{ message: string; hints: string[] } | null>(null);
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

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev.slice(-199), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  }, []);

  useEffect(() => {
    if (phase !== "connecting" && phase !== "scanning") return;
    const started = Date.now();
    setElapsedMs(0);
    const id = setInterval(() => setElapsedMs(Date.now() - started), 100);
    return () => clearInterval(id);
  }, [phase]);

  const pushToast = useCallback((message: string, type: Toast["type"] = "error") => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type }]);
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

  const markStep = useCallback((label: string, state: StepState) => {
    activeStepRef.current = label;
    setSteps((prev) => prev.map((s) => (s.label === label ? { ...s, state } : s)));
  }, []);

  const failFlow = useCallback((message: string) => {
    if (activeStepRef.current) markStep(activeStepRef.current, "error");
    setFlowError({ message: translateError(message), hints: hintsFor(message) });
    addLog(`[ERROR] ${message}`);
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

    const daemonStep = connectMode === "usb" ? "连接手机并启动扫描程序" : "启动手机上的扫描程序";

    try {
      markStep("检查电脑端组件", "active");
      addLog("[ADB] 检查电脑端组件…");
      const adbVersion = await callBackend<string>("check_adb");
      if (stale()) return;
      addLog(`[ADB] ${adbVersion}`);
      markStep("检查电脑端组件", "done");

      let serial = target;

      if (connectMode === "wireless") {
        markStep("在局域网里找到手机", "active");
        addLog("[ADB] 在局域网里找已配对的手机…");
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
        addLog(`[ADB] 已经连上 ${found.serial}。`);
        serial = found.serial;
        setTarget(found.serial);
        markStep("在局域网里找到手机", "done");
      } else {
        // Prefer the wired transport so an old wireless one cannot hijack the scan.
        const devices = JSON.parse(await callBackend<string>("list_devices")) as {
          serial: string;
          kind: string;
          status: string;
        }[];
        if (stale()) return;
        const usb = devices.find((d) => d.kind === "usb" && d.status === "device");
        if (!usb) throw new Error("没有找到设备:这台电脑上没有处于 USB 调试状态的手机。");
        serial = usb.serial;
        setTarget(usb.serial);
      }

      markStep(daemonStep, "active");
      addLog("[ADB] 推送并启动扫描程序…");
      const started = await callBackend<string>("init_daemon", serial ? { serial } : undefined);
      if (stale()) return;
      // A wireless phone re-registers under a new name whenever its IP or debug
      // port moves, so pin whichever serial the backend really drove.
      const usedSerial = (JSON.parse(started) as { serial?: string }).serial;
      if (usedSerial && usedSerial !== target) setTarget(usedSerial);
      addLog("[SOCKET] 扫描程序已经响应。");
      markStep(daemonStep, "done");

      // Capacity is advisory: a failure here must not block the scan.
      try {
        const raw = await callBackend<string>("get_storage_info");
        if (!stale()) setCapacity(JSON.parse(raw) as Capacity);
      } catch (err: unknown) {
        addLog(`[CAPACITY] ${err instanceof Error ? err.message : String(err)}`);
      }

      setPhase("scanning");
      markStep("扫描手机存储", "active");
      addLog("[SCAN] 请求扫描 /sdcard …");
      const raw = await callBackend<string>("run_scan", { path: "/sdcard" });
      if (stale()) return;
      markStep("扫描手机存储", "done");

      markStep("整理结果", "active");
      const parsed: ScanResponse = JSON.parse(raw);
      if (parsed.status !== "ok") throw new Error(parsed.status || "扫描返回了异常状态");
      if (stale()) return;
      markStep("整理结果", "done");

      setScanData(parsed);
      setPhase("result");
      addLog(`[SCAN] 完成:${formatNumber(parsed.total_files)} 个文件,${parsed.scan_time_ms}ms。`);
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
      { label: "扫描手机存储", state: "active" },
      { label: "整理结果", state: "pending" },
    ];

    setFlowError(null);
    setSteps(rescanSteps);
    setPhase("scanning");
    addLog("[SCAN] 重新扫描 /sdcard …");
    try {
      const raw = await callBackend<string>("run_scan", { path: "/sdcard" });
      if (stale()) return;
      setSteps(rescanSteps.map((s, i) => ({ ...s, state: (i === 0 ? "done" : "active") as StepState })));
      const parsed: ScanResponse = JSON.parse(raw);
      if (stale()) return;
      setScanData(parsed);
      setPhase("result");
      addLog(`[SCAN] 完成:${parsed.scan_time_ms}ms。`);
    } catch (err: unknown) {
      if (stale()) return;
      const message = err instanceof Error ? err.message : String(err);
      setSteps(rescanSteps.map((s, i) => ({ ...s, state: (i === 0 ? "error" : s.state) as StepState })));
      setFlowError({ message: translateError(message), hints: hintsFor(message) });
      addLog(`[ERROR] ${message}`);
      setPhase("result");
    }
  }, [addLog]);

  const handleCancelWait = useCallback(() => {
    runIdRef.current++;
    addLog("[UI] 用户取消了等待。");
    pushToast("已取消等待", "info");
    setSteps(stepsFor(mode));
    setPhase(scanData ? "result" : "setup");
  }, [addLog, pushToast, scanData, mode]);

  const handleDisconnect = useCallback(async () => {
    runIdRef.current++;
    addLog("[SOCKET] 断开扫描程序…");
    try {
      await callBackend<string>("stop_daemon");
      pushToast("已断开手机", "info");
      addLog("[SOCKET] 扫描程序已退出。");
    } catch {
      addLog("[SOCKET] 扫描程序本来就没在运行。");
    }
    setScanData(null);
    setCapacity(null);
    setFlowError(null);
    setPhase("setup");
  }, [addLog, pushToast]);

  const handleDeletePaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    const base = scanDataRef.current;
    addLog(`[DELETE] 正在删除 ${paths.length} 项…`);

    let tree = base?.tree ?? null;
    let freed = 0;
    let files = 0;
    let dirs = 0;
    const failed: string[] = [];

    for (const path of paths) {
      if (base && path === base.tree.path) {
        failed.push("扫描根目录");
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
        addLog(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
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
    if (okCount > 0) pushToast(`已删除 ${okCount} 项,释放 ${formatBytes(freed)}`, "success");
    if (failed.length > 0) {
      setFlowError({
        message: `${failed.length} 项删除失败:${failed.slice(0, 3).join("、")}${failed.length > 3 ? " …" : ""}`,
        hints: ["手机上该文件可能正在被应用使用,或权限不足。"],
      });
    }
    addLog(`[DELETE] 完成:成功 ${okCount} 项,失败 ${failed.length} 项,释放 ${formatBytes(freed)}。`);
  }, [addLog, pushToast]);

  useEffect(() => {
    const timers = timerRefs.current;
    return () => { timers.forEach((t) => clearTimeout(t)); };
  }, []);

  return (
    <div className="h-screen flex flex-col bg-surface-0 overflow-hidden">
      <ToastContainer toasts={toasts} onDismiss={dismissToast} />

      {isMockMode && (
        <div className="shrink-0 bg-amber-500/15 border-b border-amber-500/30 text-amber-300 text-[11px] px-3 py-1 font-mono">
          演示数据模式 · 当前在浏览器里运行,连接的是模拟数据,不会碰到手机
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
            targetLabel={
              !target
                ? "自动找到的那一台"
                : target.includes("_adb-tls-connect")
                  ? `无线 · ${target.replace(/^adb-/, "").split(".")[0]}`
                  : target
            }
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
            flowError={flowError}
            onDismissError={() => setFlowError(null)}
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
            <span>详细日志</span>
            {logs.length > 0 && <span className="text-zinc-700">({logs.length} 条)</span>}
          </button>
          <div className="ml-auto flex items-center gap-3">
            {flowError && <span className="text-[11px] text-danger-400">最近一次操作有错误</span>}
            <button
              id="btn-settings"
              onClick={() => setSettingsOpen(true)}
              title="设置"
              aria-label="打开设置"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
            >
              <IconGear />
              设置
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
  );
}

export default App;
