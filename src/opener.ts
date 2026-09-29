import { useCallback, useEffect, useState } from "react";
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
  kind: "cache" | "download";
  nodes: FileNode[];
  need: number;
  free: number;
}

const baseName = (devicePath: string) => devicePath.slice(devicePath.lastIndexOf("/") + 1);

export function useFileOpener() {
  const [copies, setCopies] = useState<Map<string, CachedCopy>>(() => new Map());
  const [pull, setPull] = useState<PullState | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingSpace, setPendingSpace] = useState<SpaceAsk | null>(null);

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

  /**
   * Refuse up front when the volume cannot hold what is about to be pulled: an
   * `adb pull` that runs out of disk fails halfway and leaves a truncated file.
   */
  const checkSpace = useCallback(
    async (kind: "cache" | "download", nodes: FileNode[], force: boolean): Promise<boolean> => {
      const need = nodes.reduce((sum, node) => sum + node.size, 0);
      if (force || need === 0) return true;
      try {
        const { free } = JSON.parse(await callBackend<string>("disk_free", { kind })) as { free: number };
        if (need <= free) return true;
        setPendingSpace({ kind, nodes, need, free });
      } catch (err: unknown) {
        // Not being able to ask is no reason to block the user.
        if (!(err instanceof Error && err.message.includes("not found"))) {
          setError(err instanceof Error ? err.message : String(err));
        }
        return true;
      }
      return false;
    },
    []
  );

  const pullOne = useCallback(
    async (node: FileNode, kind: "cache" | "download", open: boolean) => {
      setPull({ path: node.path, done: 0, total: node.size });
      mark(node.path, { state: "active", done: 0, error: undefined });
      try {
        if (isMockMode) {
          await new Promise((r) => setTimeout(r, 700));
        } else {
          await callBackend<string>("pull_file", {
            devicePath: node.path,
            size: node.size,
            mtime: node.mtime ?? 0,
            open,
            kind,
          });
        }
        mark(node.path, { state: "done", done: node.size });
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
        setError(message);
        return false;
      } finally {
        window.setTimeout(() => setPull(null), 900);
      }
    },
    [mark]
  );

  /** Double-click: pull to the cache if needed and open it in the OS. */
  const openFile = useCallback(
    async (node: FileNode, force = false) => {
      if (node.type === "directory") return;
      if (isCached(node)) {
        await pullOne(node, "cache", true);
        return;
      }
      if (!(await checkSpace("cache", [node], force))) return;
      setQueue([{ path: node.path, name: baseName(node.path), size: node.size, done: 0, direction: "open", state: "queued" }]);
      await pullOne(node, "cache", true);
    },
    [checkSpace, isCached, pullOne]
  );

  /** 下载所选: everything goes to the download folder, cached or not. */
  const downloadFiles = useCallback(
    async (nodes: FileNode[], force = false) => {
      const todo = nodes.filter((n) => n.type === "file");
      if (todo.length === 0) return 0;
      if (!(await checkSpace("download", todo, force))) return 0;

      setQueue(todo.map((node) => ({
        path: node.path,
        name: baseName(node.path),
        size: node.size,
        done: 0,
        direction: "download" as const,
        state: "queued" as const,
      })));
      setDownloading(true);
      setError(null);
      let done = 0;
      for (const node of todo) {
        if (await pullOne(node, "download", false)) done += 1;
      }
      setPull(null);
      setDownloading(false);
      return done;
    },
    [checkSpace, pullOne]
  );

  /** 上传: local files into the folder currently open on the phone. */
  const uploadFiles = useCallback(
    async (paths: string[], deviceDir: string): Promise<{ name: string; bytes: number }[]> => {
      if (paths.length === 0) return [];
      setQueue(
        paths.map((path) => ({
          path,
          name: path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1),
          size: 0,
          done: 0,
          direction: "upload" as const,
          state: "queued" as const,
        }))
      );
      setDownloading(true);
      setError(null);
      const ok: { name: string; bytes: number }[] = [];

      for (const path of paths) {
        mark(path, { state: "active" });
        try {
          if (isMockMode) {
            await new Promise((r) => setTimeout(r, 700));
            ok.push({ name: path.slice(path.lastIndexOf("/") + 1), bytes: 4096 });
          } else {
            const result = JSON.parse(await callBackend<string>("push_file", { localPath: path, deviceDir })) as {
              name: string;
              bytes: number;
            };
            ok.push(result);
            mark(path, { state: "done", done: result.bytes, size: result.bytes });
            continue;
          }
          mark(path, { state: "done", done: 4096, size: 4096 });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          mark(path, { state: "failed", error: message });
          setError(message);
        }
      }

      setPull(null);
      setDownloading(false);
      return ok;
    },
    [mark]
  );

  const confirmSpace = useCallback(() => {
    const ask = pendingSpace;
    if (!ask) return;
    setPendingSpace(null);
    if (ask.kind === "cache") void openFile(ask.nodes[0], true);
    else void downloadFiles(ask.nodes, true);
  }, [downloadFiles, openFile, pendingSpace]);

  const clearQueue = useCallback(() => {
    setQueue((prev) => prev.filter((item) => item.state === "active" || item.state === "queued"));
  }, []);

  return {
    isCached,
    cachedCount: copies.size,
    pull,
    queue,
    error,
    clearError: () => setError(null),
    pendingSpace,
    cancelSpace: () => setPendingSpace(null),
    confirmSpace,
    openFile,
    downloadFiles,
    uploadFiles,
    downloading,
    clearQueue,
    refreshCache,
  };
}
