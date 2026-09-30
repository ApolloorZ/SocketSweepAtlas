import { useCallback, useEffect, useState } from "react";
import { callBackend } from "./backend";
import { formatBytes, formatDate } from "./format";
import { CANCELLED, clearDownloadRecords, downloadRecords, estimatedSeconds, DOWNLOADS_CHANGED, type QueueItem } from "./opener";
import { Panel } from "./Panel";
import { useI18n } from "./i18n";

interface Downloaded {
  name: string;
  bytes: number;
  mtime: number;
  path: string;
}

const STATE_KEYS: Record<QueueItem["state"], string> = {
  queued: "queue.queued",
  active: "queue.active",
  done: "queue.done",
  failed: "queue.failed",
};

const DIRECTION_KEYS: Record<QueueItem["direction"], string> = {
  open: "dir.open",
  download: "dir.download",
  upload: "dir.upload",
};

function QueueRow({ item }: { item: QueueItem }) {
  const { t } = useI18n();
  const ratio = item.size > 0 ? Math.min(1, item.done / item.size) : 0;
  const left = Math.max(0, item.size - item.done);
  // A transfer the user stopped is not a fault, so it is not dressed as one.
  const cancelled = item.state === "failed" && item.error === CANCELLED;
  const bad = item.state === "failed" && !cancelled;
  return (
    <div className="py-2.5 border-b border-zinc-800/70 last:border-b-0">
      <div className="flex items-center gap-2.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded border shrink-0 font-mono text-zinc-500 border-zinc-700">
          {t(DIRECTION_KEYS[item.direction])}
        </span>
        <span className="flex-1 min-w-0 text-sm text-zinc-200 truncate" title={item.path}>
          {item.name}
        </span>
        <span
          className={`text-[11px] shrink-0 ${
            bad ? "text-danger-400" : cancelled || item.state !== "done" ? "text-zinc-500" : "text-emerald-400"
          }`}
        >
          {cancelled ? t("queue.cancelled") : t(STATE_KEYS[item.state])}
          {item.state === "active" && item.size > 0 && ` ${Math.round(ratio * 100)}%`}
          {item.state === "active" && item.size > 0 && left > 0 && ` · ${t("time.aboutSec", { n: estimatedSeconds(left) })}`}
        </span>
      </div>
      <div className="mt-1.5 h-1 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] duration-200 ${
            bad ? "bg-danger-500" : item.state === "active" && item.size === 0 ? "bg-accent-500/40" : "bg-accent-500"
          }`}
          style={{ width: `${item.size === 0 && item.state === "active" ? 100 : Math.round(ratio * 100)}%` }}
        />
      </div>
      {item.error && !cancelled && <p className="mt-1 text-[11px] text-zinc-600 break-words">{item.error}</p>}
    </div>
  );
}

/** Progress for the current batch plus what already sits in the download folder. */
export function DownloadsPanel({
  queue,
  onOpenFolder,
  onCancel,
  onClear,
  onClose,
}: {
  queue: QueueItem[];
  onOpenFolder: () => void;
  onCancel: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const [files, setFiles] = useState<Downloaded[]>([]);
  const [free, setFree] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const paths = downloadRecords();
      setFiles(paths.length === 0 ? [] : (JSON.parse(await callBackend<string>("stat_paths", { paths })) as Downloaded[]));
      const space = JSON.parse(await callBackend<string>("disk_free", { kind: "download" })) as { free: number };
      setFree(space.free);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
    const redo = () => void refresh();
    window.addEventListener(DOWNLOADS_CHANGED, redo);
    return () => window.removeEventListener(DOWNLOADS_CHANGED, redo);
  }, [refresh]);

  // Keep the folder list in step with the batch as it finishes.
  useEffect(() => {
    if (queue.length > 0 && queue.every((item) => item.state === "done" || item.state === "failed")) refresh();
  }, [queue, refresh]);

  const active = queue.filter((item) => item.state === "active" || item.state === "queued");
  const finished = queue.filter((item) => item.state === "done" || item.state === "failed");

  return (
    <Panel
      title={t("transfer.title")}
      onClose={onClose}
      actions={
        <div className="flex items-center gap-2 shrink-0">
          {active.length > 0 && (
            <button
              id="btn-cancel-batch"
              onClick={onCancel}
              title={t("transfer.cancelNote")}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-100 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/50 cursor-pointer"
            >
              {t("transfer.cancel")}
            </button>
          )}
          <button
            onClick={onOpenFolder}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-pointer"
          >
            {t("transfer.openFolder")}
          </button>
        </div>
      }
    >
      <section>
        <div className="flex items-center gap-2 mb-1">
          <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex-1">
            {active.length > 0 ? t("transfer.batchActive", { count: active.length }) : t("transfer.batch")}
          </h4>
          {finished.length > 0 && (
            <button onClick={onClear} className="text-[11px] text-zinc-500 hover:text-zinc-200 cursor-pointer">
              {t("transfer.clearDone")}
            </button>
          )}
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-4">
          {queue.length === 0 ? (
            <p className="py-4 text-sm text-zinc-600">{t("transfer.empty")}</p>
          ) : (
            queue.map((item) => <QueueRow key={item.path} item={item} />)
          )}
        </div>
      </section>

      <section>
        <div className="flex items-center gap-2 mb-1">
          <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex-1">
            {t("transfer.folderCount", { count: files.length })}
          </h4>
          {files.length > 0 && (
            <button
              onClick={() => clearDownloadRecords()}
              className="text-[11px] text-zinc-500 hover:text-zinc-200 cursor-pointer"
            >
              {t("transfer.clearList")}
            </button>
          )}
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-4">
          {files.length === 0 ? (
            <p className="py-4 text-sm text-zinc-600">{t("transfer.folderEmpty")}</p>
          ) : (
            files.map((file) => (
              <div key={file.path} className="flex items-center gap-3 py-2.5 border-b border-zinc-800/70 last:border-b-0">
                <span className="flex-1 min-w-0 text-sm text-zinc-300 truncate" title={file.path}>
                  {file.name}
                </span>
                <span className="text-xs font-mono text-zinc-500 shrink-0">{formatBytes(file.bytes)}</span>
                <span className="text-[11px] font-mono text-zinc-600 shrink-0">{formatDate(file.mtime, lang)}</span>
              </div>
            ))
          )}
        </div>
        <p className="text-[11px] text-zinc-600 mt-1.5 leading-relaxed">{t("transfer.folderNote")}</p>
      </section>

      {free !== null && <p className="text-[11px] text-zinc-600">{t("transfer.diskFree", { size: formatBytes(Number(free)) })}</p>}
      {error && (
        <div className="rounded-lg border border-danger-500/40 bg-danger-500/5 px-3 py-2">
          <p className="text-xs text-zinc-300 leading-relaxed break-words">✕ {error}</p>
        </div>
      )}
    </Panel>
  );
}
