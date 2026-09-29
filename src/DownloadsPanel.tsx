import { useCallback, useEffect, useState } from "react";
import { callBackend } from "./backend";
import { formatBytes, formatDate } from "./format";
import { estimatedSeconds, type QueueItem } from "./opener";
import { Panel } from "./Panel";

interface Downloaded {
  name: string;
  bytes: number;
  mtime: number;
  path: string;
}

const STATE_LABEL: Record<QueueItem["state"], string> = {
  queued: "排队中",
  active: "进行中",
  done: "已完成",
  failed: "失败",
};

const DIRECTION_LABEL: Record<QueueItem["direction"], string> = {
  open: "打开",
  download: "下载",
  upload: "上传",
};

function QueueRow({ item }: { item: QueueItem }) {
  const ratio = item.size > 0 ? Math.min(1, item.done / item.size) : 0;
  const left = Math.max(0, item.size - item.done);
  return (
    <div className="py-2.5 border-b border-zinc-800/70 last:border-b-0">
      <div className="flex items-center gap-2.5">
        <span className="text-[10px] px-1.5 py-0.5 rounded border shrink-0 font-mono text-zinc-500 border-zinc-700">
          {DIRECTION_LABEL[item.direction]}
        </span>
        <span className="flex-1 min-w-0 text-sm text-zinc-200 truncate" title={item.path}>
          {item.name}
        </span>
        <span
          className={`text-[11px] shrink-0 ${
            item.state === "failed" ? "text-danger-400" : item.state === "done" ? "text-emerald-400" : "text-zinc-500"
          }`}
        >
          {STATE_LABEL[item.state]}
          {item.state === "active" && item.size > 0 && ` ${Math.round(ratio * 100)}%`}
          {item.state === "active" && item.size > 0 && left > 0 && ` · 约 ${estimatedSeconds(left)} 秒`}
        </span>
      </div>
      <div className="mt-1.5 h-1 rounded-full bg-zinc-800 overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] duration-200 ${
            item.state === "failed" ? "bg-danger-500" : item.state === "active" && item.size === 0 ? "bg-accent-500/40" : "bg-accent-500"
          }`}
          style={{ width: `${item.size === 0 && item.state === "active" ? 100 : Math.round(ratio * 100)}%` }}
        />
      </div>
      {item.error && <p className="mt-1 text-[11px] text-zinc-600 break-words">{item.error}</p>}
    </div>
  );
}

/** Progress for the current batch plus what already sits in the download folder. */
export function DownloadsPanel({
  queue,
  onOpenFolder,
  onClear,
  onClose,
}: {
  queue: QueueItem[];
  onOpenFolder: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<Downloaded[]>([]);
  const [free, setFree] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setFiles(JSON.parse(await callBackend<string>("dir_list", { kind: "download" })) as Downloaded[]);
      const space = JSON.parse(await callBackend<string>("disk_free", { kind: "download" })) as { free: number };
      setFree(space.free);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Keep the folder list in step with the batch as it finishes.
  useEffect(() => {
    if (queue.length > 0 && queue.every((item) => item.state === "done" || item.state === "failed")) refresh();
  }, [queue, refresh]);

  const active = queue.filter((item) => item.state === "active" || item.state === "queued");
  const finished = queue.filter((item) => item.state === "done" || item.state === "failed");

  return (
    <Panel
      title="传输"
      onClose={onClose}
      actions={
        <button
          onClick={onOpenFolder}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-pointer shrink-0"
        >
          打开文件夹
        </button>
      }
    >
      <section>
        <div className="flex items-center gap-2 mb-1">
          <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider flex-1">
            本次任务{active.length > 0 ? ` · 进行中 ${active.length}` : ""}
          </h4>
          {finished.length > 0 && (
            <button onClick={onClear} className="text-[11px] text-zinc-500 hover:text-zinc-200 cursor-pointer">
              清除已完成
            </button>
          )}
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-4">
          {queue.length === 0 ? (
            <p className="py-4 text-sm text-zinc-600">这次还没有传输任务。</p>
          ) : (
            queue.map((item) => <QueueRow key={item.path} item={item} />)
          )}
        </div>
      </section>

      <section>
        <h4 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-1">
          下载文件夹 · {files.length} 个文件
        </h4>
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 px-4">
          {files.length === 0 ? (
            <p className="py-4 text-sm text-zinc-600">文件夹还是空的。</p>
          ) : (
            files.map((file) => (
              <div key={file.path} className="flex items-center gap-3 py-2.5 border-b border-zinc-800/70 last:border-b-0">
                <span className="flex-1 min-w-0 text-sm text-zinc-300 truncate" title={file.path}>
                  {file.name}
                </span>
                <span className="text-xs font-mono text-zinc-500 shrink-0">{formatBytes(file.bytes)}</span>
                <span className="text-[11px] font-mono text-zinc-600 shrink-0">{formatDate(file.mtime)}</span>
              </div>
            ))
          )}
        </div>
        <p className="text-[11px] text-zinc-600 mt-1.5 leading-relaxed">
          这里的文件不会被自动清理。重名时会自动加 (2)、(3),不覆盖已有文件。
        </p>
      </section>

      {free !== null && <p className="text-[11px] text-zinc-600">磁盘剩余 {formatBytes(Number(free))}</p>}
      {error && (
        <div className="rounded-lg border border-danger-500/40 bg-danger-500/5 px-3 py-2">
          <p className="text-xs text-zinc-300 leading-relaxed break-words">✕ {error}</p>
        </div>
      )}
    </Panel>
  );
}
