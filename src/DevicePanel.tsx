import { useCallback, useEffect, useState } from "react";
import { callBackend, isMockMode } from "./backend";
import { Panel } from "./Panel";
import { richParts, say, useI18n, type Params } from "./i18n";

interface DeviceInfo {
  serial: string;
  model: string;
  kind: "usb" | "wireless";
  status: string;
  /** Every transport adb sees for this one phone: cable, Wi-Fi, mDNS name. */
  transports?: string[];
}

const STATUS_KEYS: Record<string, string> = {
  device: "status.device",
  unauthorized: "status.unauthorized",
  offline: "status.offline",
  recovering: "status.recovering",
  sideload: "status.sideload",
};

function StatusBadge({ status }: { status: string }) {
  const { t } = useI18n();
  const ok = status === "device";
  const key = STATUS_KEYS[status];
  return (
    <span
      className={`text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${
        ok
          ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/25"
          : "bg-amber-500/15 text-amber-300 border-amber-500/25"
      }`}
    >
      {key ? t(key) : status}
    </span>
  );
}

/** Text with `*emphasis*` marked up, so word order can differ per language. */
function Rich({ text }: { text: string }) {
  return (
    <>
      {richParts(text).map((part, i) =>
        part.em ? (
          <span key={i} className="text-zinc-200">{part.s}</span>
        ) : (
          <span key={i}>{part.s}</span>
        )
      )}
    </>
  );
}

/**
 * The fallback ladder behind the wireless button: the LAN search already failed,
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
  const { t } = useI18n();
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ key: string; params?: Params } | null>(null);
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

  // The device list changes underneath this window: the phone can pair, drop or
  // re-announce itself over mDNS while it is open, and a list frozen at the
  // moment of opening reads as "no phone found". Quietly keep it current; the
  // manual button stays for when nobody wants to wait three seconds.
  useEffect(() => {
    const id = window.setInterval(() => {
      callBackend<string>("list_devices")
        .then((raw) => setDevices(JSON.parse(raw) as DeviceInfo[]))
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(id);
  }, []);

  // The LAN search handed us the pairing endpoint it overheard, so only the
  // digits on the phone's screen are left to type.
  useEffect(() => {
    if (pairingEndpoint) setPairTarget(pairingEndpoint);
  }, [pairingEndpoint]);

  const startQr = useCallback(async () => {
    setError(null);
    setNotice(null);
    setQrState({ state: "waiting", message: "dev.qrBuilding" });
    try {
      const parsed = JSON.parse(await callBackend<string>("start_qr_pairing")) as { svg: string; text: string };
      setQr(parsed);
      setQrState({ state: "waiting", message: "dev.qrWaiting" });
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

  /** adb's own reply is appended: it is English either way and often the proof. */
  const run = async (key: string, fn: () => Promise<string>) => {
    setError(null);
    setNotice(null);
    try {
      const out = await fn();
      setNotice({ key, params: { detail: out.trim() || t("dev.done") } });
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
        setError("E#paired_but_lan");
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPairing(false);
    }
  };

  return (
    <Panel
      title={t(intent === "pair" ? "dev.pairTitle" : "dev.manageTitle")}
      wide
      onClose={onClose}
      actions={
        <button
          onClick={refresh}
          disabled={loading}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 cursor-pointer shrink-0"
        >
          {loading ? t("dev.refreshing") : t("dev.refresh")}
        </button>
      }
    >
      {intent === "pair" && (
        <p className="text-xs text-zinc-400 leading-relaxed rounded-lg border border-zinc-800 bg-zinc-950/70 px-3 py-2">
          <Rich text={t("dev.lanMiss")} />
        </p>
      )}

      {/* 1. QR: the phone scans the PC, then pairing and connecting are automatic */}
      <section>
        <div className="flex items-center gap-2 mb-2">
          <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex-1">
            {t("dev.method1")}
          </h4>
          {!qr ? (
            <button
              onClick={startQr}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-accent-600 to-accent-500 text-white hover:from-accent-500 hover:to-accent-400 cursor-pointer"
            >
              {t("dev.makeQr")}
            </button>
          ) : (
            <button
              onClick={stopQr}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-pointer"
            >
              {t("common.cancel")}
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
              <p><Rich text={t("dev.qr1")} /></p>
              <p><Rich text={t("dev.qr2")} /></p>
              <p>{t("dev.qr3")}</p>
              {qrState && (
                <p
                  className={`mt-1 font-mono ${
                    qrState.state === "error" ? "text-danger-400" : "text-accent-400"
                  }`}
                >
                  {qrState.state === "error" ? "✕" : "⟳"} {say(t, qrState.message)}
                </p>
              )}
            </div>
          </div>
        ) : (
          <p className="text-xs text-zinc-600 leading-relaxed">{t("dev.qrIdle")}</p>
        )}
      </section>

      {/* 2. Pairing code: the endpoint is usually already filled in for us */}
      <section>
        <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">
          {t("dev.method2")}
        </h4>
        <div className="flex items-center gap-2">
          <input
            value={pairTarget}
            onChange={(e) => setPairTarget(e.target.value)}
            placeholder={t("dev.codeIp")}
            className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-accent-500/50"
          />
          <input
            value={pairCode}
            onChange={(e) => setPairCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder={t("dev.code6")}
            inputMode="numeric"
            className="w-28 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-accent-500/50"
          />
          <button
            onClick={pairWithCode}
            disabled={!pairTarget.includes(":") || pairCode.length !== 6 || pairing}
            className="px-4 py-2 rounded-lg text-sm font-semibold bg-gradient-to-r from-accent-600 to-accent-500 text-white hover:from-accent-500 hover:to-accent-400 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
          >
            {pairing ? t("dev.pairing") : t("dev.pairGo")}
          </button>
        </div>
        <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">{t("dev.codeNote")}</p>
      </section>

      {/* Connected devices */}
      <section>
        <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">{t("dev.devices")}</h4>
        {devices.length === 0 && !loading && (
          <p className="text-sm text-zinc-600">{t("dev.noDevices")}</p>
        )}
        <div className="flex flex-col gap-2">
          {devices.map((d) => {
            const picked = target === d.serial;
            // A phone on both the cable and Wi-Fi is one row; the wireless leg is
            // the one worth being able to drop.
            const wireless = (d.transports ?? (d.kind === "wireless" ? [d.serial] : [])).find(
              (transport) => transport.includes(":") || transport.includes("_adb-tls-")
            );
            const extra = (d.transports ?? []).length - 1;
            return (
              <div key={d.serial} className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${picked ? "border-accent-500/50 bg-accent-500/10" : "border-zinc-800 bg-zinc-950"}`}>
                <span className={`w-11 h-7 shrink-0 rounded-md border flex items-center justify-center text-[10px] font-mono ${d.kind === "usb" ? "border-accent-500/30 text-accent-400 bg-accent-500/10" : "border-sky-500/30 text-sky-400 bg-sky-500/10"}`}>
                  {d.kind === "usb" ? "USB" : "Wi-Fi"}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-zinc-200 truncate flex items-center gap-2">
                    <span>{d.model || d.serial}</span>
                    {extra > 0 && (
                      <span
                        className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-500 font-mono shrink-0"
                        title={t("dev.transportsTip", { list: d.transports?.join("\n") ?? "" })}
                      >
                        {t("dev.transports", { count: d.transports?.length ?? 0 })}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-zinc-600 font-mono truncate">{d.serial} · {t(d.kind === "usb" ? "dev.viaUsb" : "dev.viaWifi")}</div>
                </div>
                <StatusBadge status={d.status} />
                <button
                  onClick={() => {
                    onPickTarget(picked ? null : d.serial);
                    setNotice({ key: picked ? "dev.unpicked" : "dev.picked", params: { model: d.model || d.serial } });
                    if (!picked && d.status === "device") onConnected(d.serial);
                  }}
                  className={`px-2.5 py-1.5 rounded-md text-[11px] font-semibold cursor-pointer shrink-0 ${picked ? "bg-accent-500 text-white" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}
                >
                  {t(picked ? "dev.pickScan" : "dev.pickThis")}
                </button>
                {wireless && (
                  <button
                    onClick={() => run("dev.disconnected", () => callBackend("disconnect_device", { target: wireless }))}
                    className="px-2.5 py-1.5 rounded-md text-[11px] text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 cursor-pointer shrink-0"
                  >
                    {t(d.kind === "wireless" ? "dev.disconnect" : "dev.disconnectWifi")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Last resort: dial an address by hand */}
      <details className="rounded-xl border border-zinc-800 [&>summary]:list-none [&>summary]:cursor-pointer [&>summary::-webkit-details-marker]:hidden">
        <summary className="px-4 py-2.5 text-xs font-semibold text-zinc-500 uppercase tracking-wider hover:text-zinc-300">
          ▸ {t("dev.method3")}
        </summary>
        <div className="px-4 pb-4">
          <div className="flex items-center gap-2">
            <input
              value={connectTarget}
              onChange={(e) => setConnectTarget(e.target.value)}
              placeholder={t("dev.manualPlaceholder")}
              className="flex-1 min-w-0 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-sm font-mono text-zinc-200 placeholder:text-zinc-700 focus:outline-none focus:border-accent-500/50"
            />
            <button
              onClick={async () => {
                await run("dev.connected", () => callBackend("connect_device", { target: connectTarget }));
                onConnected(connectTarget);
              }}
              disabled={!connectTarget}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-zinc-800 text-zinc-200 border border-zinc-700 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
            >
              {t("dev.connect")}
            </button>
          </div>
          <p className="text-[11px] text-zinc-600 mt-2 leading-relaxed">{t("dev.manualNote")}</p>
        </div>
      </details>

      {notice && <p className="text-xs text-emerald-400 leading-relaxed break-words">✓ {t(notice.key, notice.params)}</p>}
      {error && (
        <div className="rounded-lg border border-danger-500/40 bg-danger-500/5 px-3 py-2">
          <p className="text-xs text-zinc-300 leading-relaxed break-words">✕ {say(t, error)}</p>
        </div>
      )}
    </Panel>
  );
}
