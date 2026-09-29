import { useCallback, useEffect, useState, type ReactNode } from "react";
import { callBackend, isMockMode } from "./backend";
import { formatBytes } from "./format";
import { Panel } from "./Panel";
import { MB, type Settings } from "./settings";
import { Switch } from "./Switch";
import { LANGUAGE_CHOICES, say, useI18n, type Lang, type Params } from "./i18n";

interface DirStats {
  files: number;
  bytes: number;
  path: string;
}

function Choice<V extends string | number>({
  value,
  options,
  onChange,
}: {
  value: V;
  options: { value: V; label: string }[];
  onChange: (value: V) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 justify-end">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={`px-2.5 py-1 rounded-md text-xs font-mono cursor-pointer border ${
            value === option.value
              ? "border-accent-500/50 bg-accent-500/15 text-accent-300"
              : "border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Row({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4 py-3 border-b border-zinc-800/70 last:border-b-0">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-zinc-200">{title}</div>
        <div className="text-[11px] text-zinc-600 leading-relaxed mt-0.5">{note}</div>
      </div>
      {children}
    </div>
  );
}

/** A folder setting: the live path reads as a field, the actions sit beside it. */
function PathRow({
  title,
  note,
  path,
  custom,
  onPick,
  onReset,
}: {
  title: string;
  note: string;
  path: string | null;
  custom: boolean;
  onPick: () => void;
  onReset: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="py-3 border-b border-zinc-800/70 last:border-b-0">
      <div className="text-sm text-zinc-200 mb-2">{title}</div>
      <div className="flex items-center gap-2">
        <code
          title={path ?? undefined}
          className="flex-1 min-w-0 truncate px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-400"
        >
          {path ?? t("set.reading")}
        </code>
        <button
          onClick={onPick}
          className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-pointer shrink-0"
        >
          {t("set.pick")}
        </button>
        {custom && (
          <button
            onClick={onReset}
            className="px-3 py-1.5 rounded-lg text-[11px] text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 cursor-pointer shrink-0"
          >
            {t("set.reset")}
          </button>
        )}
      </div>
      <div className="text-[11px] text-zinc-600 leading-relaxed mt-1.5">{note}</div>
    </div>
  );
}

function Small({ children, danger, onClick, disabled }: { children: ReactNode; danger?: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-2.5 py-1.5 rounded-md text-[11px] cursor-pointer shrink-0 ${
        danger
          ? "font-semibold bg-danger-500/20 text-danger-300 border border-danger-500/40"
          : "font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed"
      }`}
    >
      {children}
    </button>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1">{title}</h4>
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-4">{children}</div>
    </section>
  );
}

/** Native folder picker; the mock build has no window to ask. */
async function pickFolder(title: string, initial: string | null): Promise<string | null> {
  if (isMockMode) return "F:\\dev\\mock-folder";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const chosen = await open({ title, directory: true, defaultPath: initial ?? undefined });
  return typeof chosen === "string" ? chosen : null;
}

export function SettingsPanel({
  settings,
  onPatch,
  target,
  onResetTarget,
  onOpenDevices,
  onClose,
}: {
  settings: Settings;
  onPatch: (changes: Partial<Settings>) => void;
  target: string | null;
  onResetTarget: () => void;
  onOpenDevices: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [cache, setCache] = useState<DirStats | null>(null);
  const [downloads, setDownloads] = useState<DirStats | null>(null);
  const [notice, setNotice] = useState<{ key: string; params?: Params } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(async () => {
    const read = async (kind: string) =>
      JSON.parse(await callBackend<string>("dir_stats", { kind })) as DirStats;
    try {
      setCache(await read("cache"));
      setDownloads(await read("download"));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const act = async (key: string, fn: () => Promise<string>, params?: Params) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice({ key, params });
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** The backend decides whether a folder is acceptable, so ask before storing. */
  const applyPath = async (key: "cachePath" | "downloadPath", value: string | null) => {
    setError(null);
    setNotice(null);
    try {
      await callBackend<string>("set_paths", { [key === "cachePath" ? "cache" : "download"]: value ?? "" });
      onPatch({ [key]: value } as Partial<Settings>);
      setNotice({ key: value ? "set.pathChanged" : "set.pathReset" });
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const chooseFolder = async (key: "cachePath" | "downloadPath", title: string, current: string | null) => {
    const chosen = await pickFolder(title, current);
    if (chosen) await applyPath(key, chosen);
  };

  return (
    <Panel title={t("app.settings")} onClose={onClose}>
      <Group title={t("set.groupAppearance")}>
        <Row title={t("set.dark")} note={t("set.darkNote")}>
          <Switch
            on={settings.theme === "dark"}
            onToggle={() => onPatch({ theme: settings.theme === "dark" ? "light" : "dark" })}
            label={settings.theme === "dark" ? t("set.darkToLight") : t("set.darkToDeep")}
          />
        </Row>
        <Row title={t("set.language")} note={t("set.languageNote")}>
          <Choice<Lang>
            value={settings.lang}
            options={LANGUAGE_CHOICES}
            onChange={(lang) => onPatch({ lang })}
          />
        </Row>
      </Group>

      <Group title={t("set.groupScan")}>
        <Row title={t("set.logs")} note={t("set.logsNote")}>
          <Switch on={settings.logsOpen} onToggle={() => onPatch({ logsOpen: !settings.logsOpen })} label={t("set.logs")} />
        </Row>
      </Group>

      <Group title={t("set.groupCache")}>
        <PathRow
          title={t("set.cachePath")}
          note={t("set.cachePathNote")}
          path={cache?.path ?? null}
          custom={Boolean(settings.cachePath)}
          onPick={() => void chooseFolder("cachePath", t("set.groupCache"), cache?.path ?? null)}
          onReset={() => void applyPath("cachePath", null)}
        />

        <Row
          title={cache ? t("set.used", { size: formatBytes(cache.bytes), count: cache.files }) : t("set.counting")}
          note={t("set.cacheNote")}
        >
          {confirmClear ? (
            <div className="flex gap-2 shrink-0">
              <Small
                danger
                onClick={() => {
                  setConfirmClear(false);
                  void act("set.cleared", () => callBackend<string>("trim_cache", { limitBytes: 0, all: true }));
                }}
              >
                {t("set.confirmClear")}
              </Small>
              <Small onClick={() => setConfirmClear(false)}>{t("common.cancel")}</Small>
            </div>
          ) : (
            <div className="flex gap-2 shrink-0">
              <Small onClick={() => void act("set.openedFolder", () => callBackend("reveal_folder", { kind: "cache" }))}>
                {t("set.openFolder")}
              </Small>
              <Small onClick={() => setConfirmClear(true)} disabled={!cache || cache.files === 0}>
                {t("set.clearCache")}
              </Small>
            </div>
          )}
        </Row>

        <Row title={t("set.limit")} note={t("set.limitNote")}>
          <Choice
            value={settings.cacheLimitMb}
            options={[
              { value: 512, label: "512 MB" },
              { value: 2048, label: "2 GB" },
              { value: 10240, label: "10 GB" },
              { value: 1024 * 1024, label: t("set.limitNone") },
            ]}
            onChange={(cacheLimitMb) => {
              onPatch({ cacheLimitMb });
              void act(
                "set.trimmed",
                () => callBackend<string>("trim_cache", { limitBytes: cacheLimitMb * MB, all: false })
              );
            }}
          />
        </Row>

        <Row title={t("set.exitClear")} note={t("set.exitClearNote")}>
          <Switch
            on={settings.clearCacheOnExit}
            onToggle={() => {
              const next = !settings.clearCacheOnExit;
              onPatch({ clearCacheOnExit: next });
              void callBackend("set_paths", { clearOnExit: next }).catch(() => undefined);
            }}
            label={t("set.exitClear")}
          />
        </Row>
      </Group>

      <Group title={t("set.groupDownload")}>
        <PathRow
          title={t("set.dlPath")}
          note={t("set.dlPathNote")}
          path={downloads?.path ?? null}
          custom={Boolean(settings.downloadPath)}
          onPick={() => void chooseFolder("downloadPath", t("set.groupDownload"), downloads?.path ?? null)}
          onReset={() => void applyPath("downloadPath", null)}
        />

        <Row
          title={downloads ? t("set.used", { size: formatBytes(downloads.bytes), count: downloads.files }) : t("set.counting")}
          note={t("set.dlNote")}
        >
          <Small onClick={() => void act("set.openedFolder", () => callBackend("reveal_folder", { kind: "download" }))}>
            {t("set.openFolder")}
          </Small>
        </Row>
      </Group>

      <Group title={t("set.groupDevice")}>
        <Row
          title={target ? t("set.deviceTarget", { target }) : t("set.deviceAuto")}
          note={t("set.deviceNote")}
        >
          <div className="flex gap-2 shrink-0">
            <Small onClick={onOpenDevices}>{t("set.manageDevices")}</Small>
            {target && <Small onClick={onResetTarget}>{t("set.backAuto")}</Small>}
          </div>
        </Row>
      </Group>

      {notice && <p className="text-xs text-emerald-400 leading-relaxed break-words">✓ {t(notice.key, notice.params)}</p>}
      {error && (
        <div className="rounded-lg border border-danger-500/40 bg-danger-500/5 px-3 py-2">
          <p className="text-xs text-zinc-300 leading-relaxed break-words">✕ {say(t, error)}</p>
        </div>
      )}
    </Panel>
  );
}
