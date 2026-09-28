import { useCallback, useEffect, useState } from "react";
import { callBackend, isMockMode } from "./backend";
import { MB, readSettings } from "./settings";
import type { FileNode } from "./types";

// Measured on the owner's Redmi K40 over USB: ~38 MB/s, plus ~200 ms of adb
// startup per file.
export const PULL_BYTES_PER_SEC = 38 * MB;

export function cachedNameFor(devicePath: string): string {
  return devicePath
    .replace(/^\//, "")
    .replace(/\//g, "_")
    .replace(/[:*?"<>|]/g, "_");
}

export function estimatedSeconds(size: number): number {
  return Math.max(1, Math.round(size / PULL_BYTES_PER_SEC));
}

export interface PullState {
  path: string;
  done: number;
  total: number;
}

export function useFileOpener() {
  const [cached, setCached] = useState<Set<string>>(() => new Set());
  const [pull, setPull] = useState<PullState | null>(null);
  const [pendingLarge, setPendingLarge] = useState<FileNode | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshCache = useCallback(async () => {
    if (isMockMode) return;
    try {
      setCached(new Set(await callBackend<string[]>("cached_files")));
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
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen<PullState>("pull-progress", (event) => {
        if (!cancelled) setPull(event.payload);
      }))
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

  const isCached = useCallback(
    (node: FileNode) => cached.has(cachedNameFor(node.path)),
    [cached]
  );

  // Pulling is the only thing that grows the cache, so trimming happens here.
  const trimCache = useCallback(() => {
    if (isMockMode) return;
    callBackend<string>("trim_cache", { limitBytes: readSettings().cacheLimitMb * MB }).catch(() => undefined);
  }, []);

  const openFile = useCallback(
    async (node: FileNode, skipSizeCheck = false) => {
      if (node.type === "directory") return;
      const limit = readSettings().largeFileMb * MB;
      if (!skipSizeCheck && !isCached(node) && node.size > limit) {
        setPendingLarge(node);
        return;
      }
      setPendingLarge(null);
      setPull({ path: node.path, done: 0, total: node.size });
      setError(null);
      try {
        if (isMockMode) {
          await new Promise((r) => setTimeout(r, 900));
        } else {
          await callBackend<string>("pull_file", {
            devicePath: node.path,
            size: node.size,
            open: true,
          });
        }
        setCached((prev) => new Set(prev).add(cachedNameFor(node.path)));
        trimCache();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        window.setTimeout(() => setPull(null), 900);
      }
    },
    [isCached, trimCache]
  );

  /** 下载所选: keep the copies in the download folder, under their own names. */
  const downloadFiles = useCallback(async (nodes: FileNode[]) => {
    const todo = nodes.filter((n) => n.type === "file" && !isCached(n));
    if (todo.length === 0) return 0;
    setDownloading(true);
    setError(null);
    let done = 0;
    for (const node of todo) {
      setPull({ path: node.path, done: 0, total: node.size });
      try {
        if (isMockMode) {
          await new Promise((r) => setTimeout(r, 500));
        } else {
          await callBackend<string>("pull_file", { devicePath: node.path, size: node.size, open: false, kind: "download" });
        }
        done += 1;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        break;
      }
    }
    setPull(null);
    setDownloading(false);
    return done;
  }, [isCached]);

  return {
    cached,
    isCached,
    pull,
    error,
    clearError: () => setError(null),
    pendingLarge,
    cancelLarge: () => setPendingLarge(null),
    confirmLarge: (node: FileNode) => openFile(node, true),
    openFile,
    downloadFiles,
    downloading,
    refreshCache,
  };
}
