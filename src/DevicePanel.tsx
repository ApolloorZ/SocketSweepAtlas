import { useCallback, useEffect, useState } from "react";
import { callBackend, isMockMode } from "./backend";

interface DeviceInfo {
  serial: string;
  model: string;
  kind: "usb" | "wireless";
  status: string;
}

const STATUS_LABELS: Record<string, string> = {
  device: "可用",
  unauthorized: "手机上没点允许",
  offline: "离线",
  recovering: "恢复中",
  sideload: "侧载模式",
};

function StatusBadge({ status }: { status: string }) {
  const ok = status === "device";
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${
        ok
          ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/25"
          : "bg-amber-500/15 text-amber-300 border-amber-500/25"
      }`}
    >
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

/**
 * The fallback ladder behind the 无线连接 button: the LAN search already failed,
 * so this is where presence gets proven — by QR, by the 6 digit code, or by hand.
 * It also doubles as the device manager.
 */
export function DevicePanel({
  target,
  intent,
  pairingEndpoint,
  onPickTarget,
  onConnected,
  onClose,
}: {
  target: string | null;
  intent: "manage" | "pair";
  pairingEndpoint: string | null;
  onPickTarget: (serial: string | null) => void;
  onConnected: (serial: string) => void;
  onClose: () => void;
}) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairTarget, setPairTarget] = useState(pairingEndpoint ?? "");
  const [pairCode, setPairCode] = useState("");
  const [pairing, setPairing] = useState(false);
  const [connectTarget, setConnectTarget] = useState("");
  const [qr, setQr] = useState<{ svg: string; text: string } | null>(null);
  const [qrState, setQrState] = useState<{ state: string; message: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const raw = await callBackend<string>("list_devices");
      setDevices(JSON.parse(raw) as DeviceInfo[]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // The LAN search handed us the pairing endpoint it overheard, so only the
  // digits on the phone's screen are left to type.
  useEffect(() => {
    if (pairingEndpoint) setPairTarget(pairingEndpoint);
  }, [pairingEndpoint]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const startQr = useCallback(async () => {
    setError(null);
    setNotice(null);
    setQrState({ state: "waiting", message: "正在生成二维码…" });
    try {
      const parsed = JSON.parse(await callBackend<string>("start_qr_pairing")) as { svg: string; text: string };
      setQr(parsed);
      setQrState({ state: "waiting", message: "等待手机扫码…" });
    } catch (err: unknown) {
      setQrState(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Reaching this panel means the hands-off search failed, so in pairing intent
  // the QR is the fastest way out and goes up without another click.
  useEffect(() => {
    if (intent === "pair") void startQr();
    return () => {
      callBackend("cancel_qr_pairing").catch(() => undefined);
    };
  }, [intent, startQr]);

  // The pairing worker reports back through this event; on success the caller
  // takes over and runs the whole scan flow.
  useEffect(() => {
    if (!qr || isMockMode) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ state: string; message: string; serial: string | null }>("pair-progress", (event) => {
          if (cancelled) return;
          const { state, message, serial } = event.payload;
          setQrState({ state, message });
          if (state === "connected" && serial) onConnected(serial);
        })
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [qr, onConnected]);

  const stopQr = () => {
    callBackend("cancel_qr_pairing").catch(() => undefined);
    setQr(null);
    setQrState(null);
  };

  const run = async (label: string, fn: () => Promise<string>) => {
    setError(null);
    setNotice(null);
    try {
      const out = await fn();
      setNotice(`${label}:${out.trim() || "完成"}`);
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pairWithCode = async () => {
    setError(null);
    setNotice(null);
    setPairing(true);
    try {
      await callBackend<string>("pair_device", { target: pairTarget, code: pairCode });
      // Pairing and connecting are separate in adb; let the LAN search finish
      // the job instead of asking for the address a second time.
      const found = JSON.parse(await callBackend<string>("wireless_auto_connect")) as {
        status: string;
        serial: string | null;
      };
      if (found.status === "connected" && found.serial) {
        onConnected(found.serial);
      } else {
        setError("配对成功了,但局域网里还是连不上。确认手机开着「无线调试」、和电脑在同一个 Wi-Fi,再点一次连接。");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPairing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-2xl shadow-2xl animate-fade-in-up max-h-[90vh] overflow-y-auto">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-zinc-800 sticky top-0 bg-zinc-900">
          <h3 className="text-base font-bold text-zinc-100 flex-1">
            {intent === "pair" ? "配对手机(只需做一次)" : "连接的设备"}
          </h3>
          <button onClick={refresh} disabled={loading} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 cursor-pointer">
            {loading ? "刷新中…" : "↻ 刷新"}
          </button>
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 cursor-pointer">
            关闭 (Esc)
          </button>
        </div>

        <div className="px-6 py-4 flex flex-col gap-5">
          {intent === "pair" && (
            <p className="text-xs text-zinc-400 leading-relaxed rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2">
              局域网里没找到手机。<span className="text-zinc-200">先在手机上把「无线调试」这个页面打开着别退出</span>
              —— 不少国产系统只在这个页面开着的时候对外广播,电脑才发现得了它。
              页面里已经能连上的话,直接点下面的方式一扫码,或者把手机上显示的 IP:端口 填到方式三。
            </p>
          )}

          {/* 1. QR: the phone scans the PC, then pairing and connecting are automatic */}
          <section>
            <div className="flex items-center gap-2 mb-2">
              <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex-1">
                方式一:扫码配对(最省事)
              </h4>
              {!qr ? (
                <button
                  onClick={startQr}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-accent-600 to-accent-500 text-white hover:from-accent-500 hover:to-accent-400 cursor-pointer"
                >
                  生成二维码
                </button>
              ) : (
                <button
                  onClick={stopQr}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-pointer"
                >
                  取消
                </button>
              )}
            </div>

            {qr ? (
              <div className="flex items-center gap-5">
                <div
                  className="w-52 h-52 shrink-0 rounded-xl bg-white p-3 [&>svg]:w-full [&>svg]:h-full"
                  dangerouslySetInnerHTML={{ __html: qr.svg }}
                />
                <div className="flex flex-col gap-2 text-xs text-zinc-400 leading-relaxed">
                  <p>1. 手机:设置 → 开发者选项 → <span className="text-zinc-200">无线调试</span> 打开</p>
                  <p>2. 点 <span className="text-zinc-200">「使用二维码配对设备」</span>,对准左边这个码扫一下</p>
                  <p>3. 剩下的全自动:配对 → 连接 → 开始扫描,不用输任何东西</p>
                  {qrState && (
                    <p
                      className={`mt-1 font-mono ${
                        qrState.state === "error" ? "text-danger-400" : "text-accent-400"
                      }`}
                    >
                      {qrState.state === "error" ? "✕" : "⟳"} {qrState.message}
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-xs text-zinc-600 leading-relaxed">
                手机扫电脑屏幕上的码完成配对,全程不用输入 IP、端口或配对码。要求手机和电脑连着同一个 Wi-Fi。
              </p>
            )}
          </section>

          {/* 2. Pairing code: the endpoint is usually already filled in for us */}
          <section>
            <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
              方式二:输入手机显示的 6 位配对码
            </h4>
            <ol className="text-[11px] text-zinc-600 leading-relaxed mb-2 list-decimal list-inside flex flex-col gap-0.5">
              <li>手机:无线调试 → 「使用配对码配对设备」</li>
              <li>左边那格是电脑在局域网里听到的地址,一般已经替你填好;不对就照手机上那行改</li>
              <li>把手机上那 6 位数字填进右边,点配对并连接</li>
            </ol>
            <div className="flex items-center gap-2">
              <input
                value={pairTarget}
                onChange={(e) => setPairTarget(e.target.value)}
                placeholder="例如 192.168.1.23:41275"
                className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-accent-500/50"
              />
              <input
                value={pairCode}
                onChange={(e) => setPairCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="6 位码"
                inputMode="numeric"
                className="w-28 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-accent-500/50"
              />
              <button
                onClick={pairWithCode}
                disabled={!pairTarget.includes(":") || pairCode.length !== 6 || pairing}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-gradient-to-r from-accent-600 to-accent-500 text-white hover:from-accent-500 hover:to-accent-400 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
              >
                {pairing ? "配对中…" : "配对并连接"}
              </button>
            </div>
            <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">
              提示:「使用配对码配对设备」里的端口,和「无线调试」主界面上那个 IP:端口不是同一个,别填混了。6 位码过期就再点一次手机上的按钮。
            </p>
          </section>

          {/* Connected devices */}
          <section>
            <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">当前检测到的设备</h4>
            {devices.length === 0 && !loading && (
              <p className="text-sm text-zinc-600">一台设备都没检测到。插着数据线的话,检查一下手机上是否允许了 USB 调试。</p>
            )}
            <div className="flex flex-col gap-2">
              {devices.map((d) => {
                const picked = target === d.serial;
                return (
                  <div key={d.serial} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${picked ? "border-accent-500/50 bg-accent-500/10" : "border-zinc-800 bg-zinc-950"}`}>
                    <span className={`w-11 h-7 shrink-0 rounded-md border flex items-center justify-center text-[10px] font-mono ${d.kind === "usb" ? "border-accent-500/30 text-accent-400 bg-accent-500/10" : "border-sky-500/30 text-sky-400 bg-sky-500/10"}`}>
                      {d.kind === "usb" ? "USB" : "Wi-Fi"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-zinc-200 truncate">{d.model || d.serial}</div>
                      <div className="text-[11px] text-zinc-600 font-mono truncate">{d.serial} · {d.kind === "usb" ? "USB 线" : "无线"}</div>
                    </div>
                    <StatusBadge status={d.status} />
                    <button
                      onClick={() => {
                        onPickTarget(picked ? null : d.serial);
                        setNotice(picked ? "已改回自动选择设备。" : `已指定使用 ${d.model || d.serial}。`);
                        if (!picked && d.status === "device") onConnected(d.serial);
                      }}
                      className={`px-2.5 py-1.5 rounded-md text-[11px] font-semibold cursor-pointer shrink-0 ${picked ? "bg-accent-500 text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}
                    >
                      {picked ? "用这台扫描" : "用这台"}
                    </button>
                    {d.kind === "wireless" && (
                      <button
                        onClick={() => run("已断开", () => callBackend("disconnect_device", { target: d.serial }))}
                        className="px-2.5 py-1.5 rounded-md text-[11px] text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 cursor-pointer shrink-0"
                      >
                        断开
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">
              不指定设备时,程序自动用列表里的第一台。同时插着线又开着无线时,建议明确指定一台,免得扫错机器。
            </p>
          </section>

          {/* Last resort: dial an address by hand */}
          <details className="rounded-xl border border-zinc-800 [&>summary]:list-none [&>summary]:cursor-pointer [&>summary::-webkit-details-marker]:hidden">
            <summary className="px-4 py-2.5 text-xs font-semibold text-zinc-500 uppercase tracking-wider hover:text-zinc-300">
              ▸ 方式三:手动填 IP:端口 连接(前两种都不行时)
            </summary>
            <div className="px-4 pb-4">
              <ol className="text-[11px] text-zinc-600 leading-relaxed mb-2 list-decimal list-inside flex flex-col gap-0.5">
                <li>用「无线调试」主界面上显示的 IP:端口(不是配对码那个端口)</li>
                <li>这只在局域网发现失灵时才需要,比如手机和电脑不在同一个网段</li>
              </ol>
              <div className="flex items-center gap-2">
                <input
                  value={connectTarget}
                  onChange={(e) => setConnectTarget(e.target.value)}
                  placeholder="例如 192.168.1.23:5555"
                  className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-accent-500/50"
                />
                <button
                  onClick={async () => {
                    await run("连接成功", () => callBackend("connect_device", { target: connectTarget }));
                    onConnected(connectTarget);
                  }}
                  disabled={!connectTarget}
                  className="px-4 py-2 rounded-lg text-sm font-semibold bg-zinc-800 text-zinc-200 border border-zinc-700 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
                >
                  连接
                </button>
              </div>
            </div>
          </details>

          {notice && (
            <p className="text-xs text-emerald-400 leading-relaxed break-words">✓ {notice}</p>
          )}
          {error && (
            <div className="rounded-lg border border-danger-500/40 bg-danger-500/5 px-3 py-2">
              <p className="text-xs text-zinc-300 leading-relaxed break-words">✕ {error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
