import { useCallback, useEffect, useState, type ReactNode } from "react";
import { callBackend, isMockMode } from "./backend";
import { formatBytes } from "./format";
import { Panel } from "./Panel";
import { MB, type Settings } from "./settings";
import { Switch } from "./Switch";

interface DirStats {
  files: number;
  bytes: number;
  path: string;
}

function Choice({
  value,
  options,
  onChange,
}: {
  value: number;
  options: { value: number; label: string }[];
  onChange: (value: number) => void;
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
  return (
    <div className="py-3 border-b border-zinc-800/70 last:border-b-0">
      <div className="text-sm text-zinc-200 mb-2">{title}</div>
      <div className="flex items-center gap-2">
        <code
          title={path ?? undefined}
          className="flex-1 min-w-0 truncate px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-400"
        >
          {path ?? "正在读取…"}
        </code>
        <button
          onClick={onPick}
          className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-pointer shrink-0"
        >
          选择文件夹
        </button>
        {custom && (
          <button
            onClick={onReset}
            className="px-3 py-1.5 rounded-lg text-[11px] text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 cursor-pointer shrink-0"
          >
            恢复默认
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
  const [cache, setCache] = useState<DirStats | null>(null);
  const [downloads, setDownloads] = useState<DirStats | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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

  const act = async (label: string, fn: () => Promise<string>) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(label);
      await refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const chooseFolder = async (key: "cachePath" | "downloadPath", title: string, current: string | null) => {
    const chosen = await pickFolder(title, current);
    if (!chosen) return;
    onPatch({ [key]: chosen } as Partial<Settings>);
    await act("已改用新的位置。", () =>
      callBackend<string>("set_paths", { [key === "cachePath" ? "cache" : "download"]: chosen })
    );
  };

  const resetFolder = async (key: "cachePath" | "downloadPath") => {
    onPatch({ [key]: null } as Partial<Settings>);
    await act("已恢复默认位置。", () =>
      callBackend<string>("set_paths", { [key === "cachePath" ? "cache" : "download"]: "" })
    );
  };

  return (
    <Panel title="设置" onClose={onClose}>
      <Group title="外观">
        <Row title="深色模式" note="整套界面一起切换">
          <Switch
            on={settings.theme === "dark"}
            onToggle={() => onPatch({ theme: settings.theme === "dark" ? "light" : "dark" })}
            label={settings.theme === "dark" ? "切换到浅色" : "切换到深色"}
          />
        </Row>
      </Group>

      <Group title="扫描">
        <Row title="详细日志默认展开" note="排查连接问题时才有用">
          <Switch on={settings.logsOpen} onToggle={() => onPatch({ logsOpen: !settings.logsOpen })} label="详细日志默认展开" />
        </Row>
      </Group>

      <Group title="缓存">
        <PathRow
          title="缓存位置"
          note="双击打开的文件先落到这里;换位置不搬旧文件"
          path={cache?.path ?? null}
          custom={Boolean(settings.cachePath)}
          onPick={() => void chooseFolder("cachePath", "缓存", cache?.path ?? null)}
          onReset={() => void resetFolder("cachePath")}
        />

        <Row title="大文件提醒" note="超过这个大小先问一句">
          <Choice
            value={settings.largeFileMb}
            options={[
              { value: 100, label: "100 MB" },
              { value: 300, label: "300 MB" },
              { value: 500, label: "500 MB" },
              { value: 1024, label: "1 GB" },
            ]}
            onChange={(largeFileMb) => onPatch({ largeFileMb })}
          />
        </Row>

        <Row
          title={cache ? `${formatBytes(cache.bytes)} · ${cache.files} 个文件` : "正在统计…"}
          note="电脑上的副本,删了不影响手机原件"
        >
          {confirmClear ? (
            <div className="flex gap-2 shrink-0">
              <Small
                danger
                onClick={() => {
                  setConfirmClear(false);
                  void act("缓存已清空。", () => callBackend<string>("trim_cache", { limitBytes: 0, all: true }));
                }}
              >
                确定清空
              </Small>
              <Small onClick={() => setConfirmClear(false)}>取消</Small>
            </div>
          ) : (
            <div className="flex gap-2 shrink-0">
              <Small onClick={() => void act("已在资源管理器里打开。", () => callBackend("reveal_folder", { kind: "cache" }))}>
                打开文件夹
              </Small>
              <Small onClick={() => setConfirmClear(true)} disabled={!cache || cache.files === 0}>
                清空缓存
              </Small>
            </div>
          )}
        </Row>

        <Row title="缓存上限" note="超出后自动丢掉最旧的副本">
          <Choice
            value={settings.cacheLimitMb}
            options={[
              { value: 512, label: "512 MB" },
              { value: 2048, label: "2 GB" },
              { value: 10240, label: "10 GB" },
              { value: 1024 * 1024, label: "不清理" },
            ]}
            onChange={(cacheLimitMb) => {
              onPatch({ cacheLimitMb });
              void act(
                "已按新上限整理过缓存。",
                () => callBackend<string>("trim_cache", { limitBytes: cacheLimitMb * MB, all: false })
              );
            }}
          />
        </Row>

        <Row title="退出软件前清空缓存" note="关窗口时删掉所有缓存副本">
          <Switch
            on={settings.clearCacheOnExit}
            onToggle={() => {
              const next = !settings.clearCacheOnExit;
              onPatch({ clearCacheOnExit: next });
              void callBackend("set_paths", { clearOnExit: next }).catch(() => undefined);
            }}
            label="退出软件前清空缓存"
          />
        </Row>
      </Group>

      <Group title="下载">
        <PathRow
          title="下载位置"
          note="「下载所选」落在这里,保留原文件名,不自动清理"
          path={downloads?.path ?? null}
          custom={Boolean(settings.downloadPath)}
          onPick={() => void chooseFolder("downloadPath", "下载", downloads?.path ?? null)}
          onReset={() => void resetFolder("downloadPath")}
        />

        <Row
          title={downloads ? `${formatBytes(downloads.bytes)} · ${downloads.files} 个文件` : "正在统计…"}
          note="重名自动加 (2),不覆盖已有文件"
        >
          <Small onClick={() => void act("已在资源管理器里打开。", () => callBackend("reveal_folder", { kind: "download" }))}>
            打开文件夹
          </Small>
        </Row>
      </Group>

      <Group title="设备">
        <Row
          title={target ? `已指定:${target}` : "自动使用检测到的第一台"}
          note="同时连着线和无线时更保险"
        >
          <div className="flex gap-2 shrink-0">
            <Small onClick={onOpenDevices}>管理设备与配对</Small>
            {target && <Small onClick={onResetTarget}>改回自动</Small>}
          </div>
        </Row>
      </Group>

      {notice && <p className="text-xs text-emerald-400 leading-relaxed break-words">✓ {notice}</p>}
      {error && (
        <div className="rounded-lg border border-danger-500/40 bg-danger-500/5 px-3 py-2">
          <p className="text-xs text-zinc-300 leading-relaxed break-words">✕ {error}</p>
        </div>
      )}
    </Panel>
  );
}
