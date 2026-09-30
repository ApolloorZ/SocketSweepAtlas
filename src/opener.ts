import { useCallback, useEffect, useRef, useState } from "react";
import { callBackend, isMockMode } from "./backend";
import type { FileNode } from "./types";

// Measured on the owner's Redmi K40 over USB: ~38 MB/s, plus ~200 ms of adb
// startup per file.
export const PULL_BYTES_PER_SEC = 38 * 1024 * 1024;

export function estimatedSeconds(size: number): number {
  return Math.max(1, Math.round(size / PULL_BYTES_PER_SEC));
}

/**
 * Mirrors `cached_file_name` in src-tauri/src/lib.rs: the flattened device path
 * plus an FNV-1a tag of the original path, inserted before the extension. Both
 * sides have to agree or every row would look uncached.
 */
export function cachedNameFor(devicePath: string): string {
  const flat = devicePath
    .replace(/^\//, "")
    .replace(/\//g, "_")
    .replace(/[:*?"<>|]/g, "_");
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(devicePath)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  const tag = `-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  const dot = flat.lastIndexOf(".");
  return dot > 0 && dot < flat.length - 1
    ? `${flat.slice(0, dot)}${tag}${flat.slice(dot)}`
    : `${flat}${tag}`;
}

interface CachedCopy {
  bytes: number;
  mtime: number;
}

export interface PullState {
  path: string;
  done: number;
  total: number;
}

export interface QueueItem {
  path: string;
  name: string;
  size: number;
  done: number;
  /** Which way the bytes moved, and for downloads what they were for. */
  direction: "open" | "download" | "upload";
  state: "queued" | "active" | "done" | "failed";
  error?: string;
}

export interface SpaceAsk {
  /** Which volume is short: the PC's, or the phone's. */
  scope: "pc" | "phone";
  /** The folder the bytes were heading for, as the user knows it. */
  where: string;
  need: number;
  free: number;
  items: number;
}

/** What to re-run with the check bypassed if the user insists on trying. */
type Job =
  | { kind: "cache"; node: FileNode }
  | { kind: "download"; nodes: FileNode[] }
  | { kind: "upload"; paths: string[]; deviceDir: string };

const baseName = (devicePath: string) => devicePath.slice(devicePath.lastIndexOf("/") + 1);
const lastName = (localPath: string) =>
  localPath.slice(Math.max(localPath.lastIndexOf("/"), localPath.lastIndexOf("\\")) + 1);

/** What a stopped transfer says on every row it left behind. `wait_for_transfer`
 *  in src-tauri/src/lib.rs answers with the same code, so the two must match. */
export const CANCELLED = "E#cancelled";

/** Broadcast when the cache folder changed outside the file list. */
export const CACHE_CHANGED = "ss-cache-changed";

/** Broadcast when the app's own download list grows or is cleared. */
export const DOWNLOADS_CHANGED = "ss-downloads-changed";

const DOWNLOADS_KEY = "ss-downloads";
const DOWNLOADS_MAX = 200;

/**
 * Where the files this app pulled landed. The download folder itself is no use
 * as a list — it is the user's folder and full of other things.
 */
export function downloadRecords(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DOWNLOADS_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function clearDownloadRecords(): void {
  localStorage.removeItem(DOWNLOADS_KEY);
  window.dispatchEvent(new Event(DOWNLOADS_CHANGED));
}

function rememberDownload(localPath: string): void {
  const next = [localPath, ...downloadRecords().filter((p) => p !== localPath)].slice(0, DOWNLOADS_MAX);
  localStorage.setItem(DOWNLOADS_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(DOWNLOADS_CHANGED));
}

export function useFileOpener() {
  const [copies, setCopies] = useState<Map<string, CachedCopy>>(() => new Map());
  const [pull, setPull] = useState<PullState | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pendingSpace, setPendingSpace] = useState<SpaceAsk | null>(null);
  const job = useRef<Job | null>(null);
  const aborted = useRef(false);

  const refreshCache = useCallback(async () => {
    if (isMockMode) return;
    try {
      const entries = JSON.parse(await callBackend<string>("cached_entries")) as {
        name: string;
        bytes: number;
        mtime: number;
      }[];
      setCopies(new Map(entries.map((e) => [e.name, { bytes: e.bytes, mtime: e.mtime }])));
    } catch {
      // A missing cache folder is not worth interrupting the user for.
    }
  }, []);

  useEffect(() => {
    refreshCache();
  }, [refreshCache]);

  /**
   * The folder can change under us without anything here touching it: clearing
   * the cache happens in the settings panel, and he can also delete copies in the
   * file manager. Both would leave a 「已缓存」 badge on a file that is no longer
   * on the PC, so the index is re-read when either happens.
   */
  useEffect(() => {
    const redo = () => void refreshCache();
    window.addEventListener(CACHE_CHANGED, redo);
    window.addEventListener("focus", redo);
    return () => {
      window.removeEventListener(CACHE_CHANGED, redo);
      window.removeEventListener("focus", redo);
    };
  }, [refreshCache]);

  useEffect(() => {
    if (isMockMode) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const track = (event: { payload: PullState }) => {
      if (cancelled) return;
      setPull(event.payload);
      setQueue((prev) =>
        prev.map((item) =>
          item.path === event.payload.path
            ? { ...item, done: event.payload.done, size: Math.max(item.size, event.payload.total) }
            : item
        )
      );
    };

    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        Promise.all([listen<PullState>("pull-progress", track), listen<PullState>("push-progress", track)]).then(
          ([a, b]) => () => {
            a();
            b();
          }
        )
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
  }, []);

  /** A copy only counts when size and the phone's own mtime both still match. */
  const isCached = useCallback(
    (node: FileNode) => {
      const copy = copies.get(cachedNameFor(node.path));
      if (!copy || copy.bytes !== node.size) return false;
      if (!node.mtime || !copy.mtime) return true;
      return Math.abs(copy.mtime - node.mtime) <= 2;
    },
    [copies]
  );

  const mark = useCallback((path: string, patch: Partial<QueueItem>) => {
    setQueue((prev) => prev.map((item) => (item.path === path ? { ...item, ...patch } : item)));
  }, []);

  /** Free space and location of the PC folder that would hold the bytes. */
  const pcVolume = useCallback(async (kind: "cache" | "download") => {
    const info = JSON.parse(await callBackend<string>("disk_free", { kind })) as { path: string; free: number };
    return { free: info.free, where: info.path };
  }, []);

  /** Free space on the phone, read from the device itself. */
  const phoneVolume = useCallback(async (deviceDir: string) => {
    const info = JSON.parse(await callBackend<string>("get_storage_info")) as { free_bytes: number };
    return { free: info.free_bytes, where: deviceDir };
  }, []);

  /**
   * Ask the volume that has to hold the bytes whether it fits. A transfer that
   * runs out of disk halfway leaves a truncated file behind — on the phone it is
   * worse than that, so this refuses up front and lets the user override.
   */
  const roomFor = useCallback(
    async (opts: {
      scope: SpaceAsk["scope"];
      need: number;
      items: number;
      volume: () => Promise<{ free: number; where: string }>;
      job: Job;
      force: boolean;
    }): Promise<boolean> => {
      if (opts.force || opts.need <= 0) return true;
      let volume: { free: number; where: string };
      try {
        volume = await opts.volume();
      } catch {
        // Not being able to ask is no reason to block the user.
        return true;
      }
      if (volume.free <= 0 || opts.need <= volume.free) return true;
      job.current = opts.job;
      setPendingSpace({
        scope: opts.scope,
        where: volume.where,
        need: opts.need,
        free: volume.free,
        items: opts.items,
      });
      return false;
    },
    []
  );

  /** Mock transfers have to be cancellable too, without a device attached. */
  const mockTransfer = useCallback((ms: number) => {
    const started = Date.now();
    return new Promise<void>((resolve, reject) => {
      const tick = window.setInterval(() => {
        if (aborted.current) {
          window.clearInterval(tick);
          reject(new Error(CANCELLED));
        } else if (Date.now() - started >= ms) {
          window.clearInterval(tick);
          resolve();
        }
      }, 100);
    });
  }, []);

  /** A cancelled batch leaves rows in flight; say plainly that they stopped. */
  const settleAbandoned = useCallback(() => {
    setQueue((prev) =>
      prev.map((item) =>
        item.state === "queued" || item.state === "active"
          ? { ...item, state: "failed", error: CANCELLED }
          : item
      )
    );
  }, []);

  const enqueue = useCallback((items: QueueItem[]) => {
    aborted.current = false;
    job.current = null;
    setQueue(items);
  }, []);

  const pullOne = useCallback(
    async (node: FileNode, kind: "cache" | "download", open: boolean) => {
      setPull({ path: node.path, done: 0, total: node.size });
      mark(node.path, { state: "active", done: 0, error: undefined });
      try {
        let local: string | null;
        if (isMockMode) {
          await mockTransfer(700);
          local = `M:\\downloads\\${baseName(node.path)}`;
        } else {
          local = await callBackend<string>("pull_file", {
            devicePath: node.path,
            size: node.size,
            mtime: node.mtime ?? 0,
            open,
            kind,
          });
        }
        mark(node.path, { state: "done", done: node.size });
        if (kind === "download" && local) rememberDownload(local);
        if (kind === "cache") {
          setCopies((prev) => {
            const next = new Map(prev);
            next.set(cachedNameFor(node.path), { bytes: node.size, mtime: node.mtime ?? 0 });
            return next;
          });
        }
        return true;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        mark(node.path, { state: "failed", error: message });
        // A cancelled single pull is the user's own choice, not a fault.
        if (!aborted.current) setError(message);
        return false;
      } finally {
        window.setTimeout(() => setPull(null), 900);
      }
    },
    [mark, mockTransfer]
  );

  /** Double-click: pull to the cache if needed and open it in the OS. */
  const openFile = useCallback(
    async (node: FileNode, force = false) => {
      if (node.type === "directory") return;
      if (isCached(node)) {
        enqueue([{ path: node.path, name: baseName(node.path), size: node.size, done: 0, direction: "open", state: "queued" }]);
        await pullOne(node, "cache", true);
        return;
      }
      if (!(await roomFor({ scope: "pc", need: node.size, items: 1, volume: () => pcVolume("cache"), job: { kind: "cache", node }, force }))) {
        return;
      }
      enqueue([{ path: node.path, name: baseName(node.path), size: node.size, done: 0, direction: "open", state: "queued" }]);
      await pullOne(node, "cache", true);
    },
    [enqueue, isCached, pcVolume, pullOne, roomFor]
  );

  /** 下载所选: everything goes to the download folder, cached or not. */
  const downloadFiles = useCallback(
    async (nodes: FileNode[], force = false) => {
      const todo = nodes.filter((n) => n.type === "file");
      if (todo.length === 0) return 0;
      const need = todo.reduce((sum, node) => sum + node.size, 0);
      const fits = await roomFor({
        scope: "pc",
        need,
        items: todo.length,
        volume: () => pcVolume("download"),
        job: { kind: "download", nodes: todo },
        force,
      });
      if (!fits) return 0;

      enqueue(
        todo.map((node) => ({
          path: node.path,
          name: baseName(node.path),
          size: node.size,
          done: 0,
          direction: "download" as const,
          state: "queued" as const,
        }))
      );
      setError(null);
      let done = 0;
      for (const node of todo) {
        if (aborted.current) break;
        if (await pullOne(node, "download", false)) done += 1;
      }
      if (aborted.current) settleAbandoned();
      setPull(null);
      return done;
    },
    [enqueue, pcVolume, pullOne, roomFor, settleAbandoned]
  );

  /** 上传: local files into the folder currently open on the phone. */
  const uploadFiles = useCallback(
    async (paths: string[], deviceDir: string, force = false): Promise<{ name: string; bytes: number }[]> => {
      if (paths.length === 0) return [];
      setError(null);

      // The sizes come from the PC, not the phone: adb will not tell us how much
      // it is about to write until it has written it.
      const sizes = new Map<string, number>();
      try {
        const entries = JSON.parse(await callBackend<string>("local_file_sizes", { paths })) as {
          path: string;
          bytes: number;
        }[];
        for (const entry of entries) sizes.set(entry.path, entry.bytes);
      } catch {
        // Without sizes there is nothing to pre-check; adb reports the rest.
      }
      const need = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);

      const fits = await roomFor({
        scope: "phone",
        need,
        items: paths.length,
        volume: () => phoneVolume(deviceDir),
        job: { kind: "upload", paths, deviceDir },
        force,
      });
      if (!fits) return [];

      enqueue(
        paths.map((path) => ({
          path,
          name: lastName(path),
          size: sizes.get(path) ?? 0,
          done: 0,
          direction: "upload" as const,
          state: "queued" as const,
        }))
      );

      const ok: { name: string; bytes: number }[] = [];
      for (const path of paths) {
        if (aborted.current) break;
        mark(path, { state: "active" });
        try {
          if (isMockMode) {
            await mockTransfer(900);
            ok.push({ name: lastName(path), bytes: sizes.get(path) ?? 4096 });
          } else {
            const result = JSON.parse(await callBackend<string>("push_file", { localPath: path, deviceDir })) as {
              name: string;
              bytes: number;
            };
            ok.push(result);
            mark(path, { state: "done", done: result.bytes, size: result.bytes });
            continue;
          }
          mark(path, { state: "done", done: sizes.get(path) ?? 4096, size: sizes.get(path) ?? 4096 });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          mark(path, { state: "failed", error: message });
          if (!aborted.current) setError(message);
        }
      }
      if (aborted.current) settleAbandoned();
      setPull(null);
      return ok;
    },
    [enqueue, mark, mockTransfer, phoneVolume, roomFor, settleAbandoned]
  );

  /** Stop the transfer in flight and let the queue wind down. */
  const cancelTransfer = useCallback(() => {
    aborted.current = true;
    if (isMockMode) return;
    void callBackend<string>("cancel_transfer").catch(() => undefined);
  }, []);

  const confirmSpace = useCallback(() => {
    const run = job.current;
    setPendingSpace(null);
    job.current = null;
    if (!run) return;
    if (run.kind === "cache") void openFile(run.node, true);
    else if (run.kind === "download") void downloadFiles(run.nodes, true);
    else void uploadFiles(run.paths, run.deviceDir, true);
  }, [downloadFiles, openFile, uploadFiles]);

  const clearQueue = useCallback(() => {
    setQueue((prev) => prev.filter((item) => item.state === "active" || item.state === "queued"));
  }, []);

  const busy = queue.some((item) => item.state === "active" || item.state === "queued");

  return {
    isCached,
    cachedCount: copies.size,
    pull,
    queue,
    busy,
    error,
    clearError: () => setError(null),
    pendingSpace,
    cancelSpace: () => {
      job.current = null;
      setPendingSpace(null);
    },
    confirmSpace,
    openFile,
    downloadFiles,
    uploadFiles,
    cancelTransfer,
    clearQueue,
    refreshCache,
  };
}
