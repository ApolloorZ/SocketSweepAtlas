import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { callBackend, isMockMode } from "./backend";
import { Treemap, ResponsiveContainer, Tooltip as RechartsTooltip } from "recharts";
import type { Capacity, FileNode, FlowError, ScanResponse } from "./types";
import { CATEGORY_ORDER, categoryLabel, type Category } from "./categories";
import { breadcrumbs, clearStatsCache, collectCategories, findNode, subtreeStats } from "./tree";
import { formatBytes, formatDate, formatNumber, percent } from "./format";
import { TypeGlyph, TypeIcon } from "./icons";
import { DownloadsPanel } from "./DownloadsPanel";
import { useFileOpener } from "./opener";
import { say, useI18n, type Params } from "./i18n";

// ── Sorting ────────────────────────────────────────────────────────────────

type SortKey = "size" | "name" | "mtime";
interface Sort { key: SortKey; desc: boolean }

function compareNodes(a: FileNode, b: FileNode, sort: Sort, locale: string): number {
  // Directories always lead, mirroring how people scan a folder list.
  if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
  const dir = sort.desc ? -1 : 1;
  switch (sort.key) {
    case "size": return (a.size - b.size) * dir;
    case "mtime": return ((a.mtime ?? 0) - (b.mtime ?? 0)) * dir;
    case "name": return a.name.localeCompare(b.name, locale);
  }
}

// ── Small presentational pieces ─────────────────────────────────────────────

function SizeBar({ ratio }: { ratio: number }) {
  const pct = Math.max(0.8, Math.min(100, ratio * 100));
  const hue = ratio > 2 / 3 ? 15 : ratio > 1 / 3 ? 45 : 180;
  return (
    <div className="w-full h-1.5 rounded-full bg-zinc-800/80 overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: `oklch(0.60 0.16 ${hue})` }} />
    </div>
  );
}

// 28px icon · name · size · share · counts/time · time/location · wide hit area for the checkbox
const GRID_BROWSE = "28px minmax(0,1fr) 110px 68px 96px 84px 44px";
const GRID_CATEGORY = "28px minmax(0,1fr) 110px 68px 92px minmax(0,1.2fr) 44px";

// ── Nothing readable ────────────────────────────────────────────────────────

const EMPTY_SCAN_CHECKLIST = [
  "empty.1",
  "empty.2",
  "empty.3",
  "empty.4",
  "empty.5",
];

export function EmptyScanScreen({
  onRescan,
  onDisconnect,
}: {
  onRescan: () => void;
  onDisconnect: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-6 py-6 flex flex-col items-center gap-5">
      <div className="text-center max-w-md">
        <div className="text-3xl mb-3">🗂️</div>
        <h2 className="text-base font-semibold text-zinc-200">{t("empty.title")}</h2>
        <p className="mt-1.5 text-sm text-zinc-500 leading-relaxed">
          {t("empty.intro")}
        </p>
      </div>
      <ul className="w-full max-w-md flex flex-col gap-2">
        {EMPTY_SCAN_CHECKLIST.map((item, i) => (
          <li key={i} className="flex gap-2.5 text-sm text-zinc-400 leading-relaxed glass-card rounded-lg px-3 py-2">
            <span className="text-accent-400 font-mono">{i + 1}</span>
            <span>{t(item)}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <button onClick={onRescan} className="px-4 py-2 rounded-lg text-xs font-semibold bg-gradient-to-r from-accent-600 to-accent-500 text-white hover:from-accent-500 hover:to-accent-400 cursor-pointer">
          {t("view.rescan")}
        </button>
        <button onClick={onDisconnect} className="px-4 py-2 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-700/50 cursor-pointer">
          {t("view.disconnect")}
        </button>
      </div>
    </div>
  );
}

// ── Header actions ──────────────────────────────────────────────────────────

function IconButton({
  id,
  label,
  onClick,
  danger,
  children,
}: {
  id: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      id={id}
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`relative w-8 h-8 rounded-lg flex items-center justify-center border cursor-pointer shrink-0 ${
        danger
          ? "bg-zinc-800 text-zinc-400 border-zinc-700/50 hover:bg-red-950/50 hover:text-red-400"
          : "bg-zinc-800 text-zinc-300 border-zinc-700/50 hover:bg-zinc-700 hover:text-zinc-100"
      }`}
    >
      {children}
    </button>
  );
}

const iconProps = {
  width: 15,
  height: 15,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const IconDownload = () => (
  <svg {...iconProps}>
    <path d="M8 2v7.5M5.2 7l2.8 2.8L10.8 7" />
    <path d="M2.5 11.5v1a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1" />
  </svg>
);

const IconRescan = () => (
  <svg {...iconProps}>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.85-4.08" />
    <path d="M13.8 2.4v2.7h-2.7" />
  </svg>
);

const IconDisconnect = () => (
  <svg {...iconProps}>
    <path d="M8 2v5" />
    <path d="M4.7 4.3a5 5 0 1 0 6.6 0" />
  </svg>
);

const IconBack = () => (
  <svg {...iconProps} width={14} height={14}>
    <path d="M9.5 3.5 5 8l4.5 4.5" />
  </svg>
);

const IconUpload = () => (
  <svg {...iconProps}>
    <path d="M8 13.5V6m0 0L5.2 8.8M8 6l2.8 2.8" />
    <path d="M2.5 4.5v-1a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v1" />
  </svg>
);

// ── Main view ───────────────────────────────────────────────────────────────

type View = "home" | "browse" | "category";

export function ResultView({
  data,
  capacity,
  onRescan,
  onDisconnect,
  onDeletePaths,
  onMovePaths,
  notify,
  onUploaded,
  flowError,
  onDismissError,
}: {
  data: ScanResponse;
  capacity: Capacity | null;
  onRescan: () => void;
  onDisconnect: () => void;
  onDeletePaths: (paths: string[]) => Promise<void>;
  onMovePaths: (paths: string[], dest: string) => Promise<void>;
  notify: (message: string, params?: Params) => void;
  onUploaded: (items: { name: string; bytes: number }[], dirPath: string) => void;
  flowError: FlowError | null;
  onDismissError: () => void;
}) {
  const { t, lang } = useI18n();
  const [view, setView] = useState<View>("home");
  const [browsePath, setBrowsePath] = useState(data.tree.path);
  const [category, setCategory] = useState<Category>("video");
  const [sort, setSort] = useState<Sort>({ key: "size", desc: true });
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(300);
  const [selected, setSelected] = useState<Map<string, FileNode>>(new Map());
  const [confirming, setConfirming] = useState(false);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [moving, setMoving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const opener = useFileOpener();

  // Where a dropped file should land. The native drag handler is registered once,
  // so it reads the live target through a ref instead of closing over state.
  const dropTarget = useRef<{ view: View; path: string }>({ view, path: browsePath });
  dropTarget.current = { view, path: browsePath };

  // Transfer failures surface as toasts rather than a strip that would push the
  // whole list down at the worst possible moment.
  useEffect(() => {
    if (!opener.error) return;
    notify(opener.error);
    opener.clearError();
  }, [opener.error]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { clearStatsCache(); }, [data]);
  useEffect(() => { setShown(300); }, [view, browsePath, category, query, sort]);

  useEffect(() => {
    if (!confirming && !opener.pendingSpace) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setConfirming(false);
      opener.cancelSpace();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, opener.pendingSpace]);

  const buckets = useMemo(() => collectCategories(data.tree), [data]);

  const denominator = capacity?.total_bytes || data.total_size;

  const crumbs = useMemo(() => breadcrumbs(data.tree, browsePath), [data.tree, browsePath]);

  const currentNode = findNode(data.tree, browsePath) ?? data.tree;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const source: FileNode[] =
      view === "category" ? (buckets.get(category)?.files ?? []) : (currentNode.children ?? []);
    const filtered = q
      ? source.filter((n) => n.name.toLowerCase().includes(q) || (view === "category" && n.path.toLowerCase().includes(q)))
      : source;
    return filtered.slice().sort((a, b) => compareNodes(a, b, sort, lang === "zh" ? "zh-Hans-CN" : "en"));
  }, [view, buckets, category, currentNode, query, sort, lang]);

  const treemapData = useMemo(() => {
    const kids = (data.tree.children ?? []).filter((c) => c.size > 0).sort((a, b) => b.size - a.size);
    const visible = kids.filter((c) => c.size / (data.total_size || 1) >= 0.015);
    const rest = kids.slice(visible.length);
    const restSize = rest.reduce((sum, c) => sum + c.size, 0);
    const out = visible.map((c) => ({ name: c.name, size: c.size, path: c.path }));
    if (rest.length > 0) {
      out.push({ name: t("view.restItems", { count: formatNumber(rest.length) }), size: restSize, path: data.tree.path });
    }
    return out;
  }, [data, t]);

  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, desc: !prev.desc } : { key, desc: true }));

  const openFolder = useCallback((path: string) => {
    setBrowsePath(path);
    setView("browse");
    setQuery("");
    setSort({ key: "size", desc: true });
    // Walking to a destination is how a move picks its target, so the marked
    // files must survive it.
    if (!moving) setSelected(new Map());
  }, [moving]);

  const parentPath = useMemo(() => {
    const root = data.tree.path;
    if (browsePath === root) return null;
    const cut = browsePath.lastIndexOf("/");
    return cut > 0 ? browsePath.slice(0, cut) : root;
  }, [browsePath, data.tree.path]);

  const runUpload = useCallback(
    async (paths: string[]) => {
      const dir = dropTarget.current.path;
      setDownloadsOpen(true);
      const ok = await opener.uploadFiles(paths, dir);
      if (ok.length > 0) onUploaded(ok, dir);
    },
    [onUploaded, opener]
  );

  const pickUpload = useCallback(async () => {
    if (isMockMode) {
      await runUpload(["/mock/selected-from-computer.jpg"]);
      return;
    }
    const { open } = await import("@tauri-apps/plugin-dialog");
    const chosen = await open({ multiple: true, title: t("view.uploadDialogTitle") });
    const paths = Array.isArray(chosen) ? chosen : chosen ? [chosen] : [];
    if (paths.length > 0) await runUpload(paths);
  }, [runUpload, t]);

  // Tauri owns drag and drop in the webview, so dropped paths arrive as a window
  // event rather than a DOM one; the mock build has nothing to drop.
  useEffect(() => {
    if (isMockMode) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) =>
        getCurrentWindow().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setDragging(dropTarget.current.view === "browse");
          } else if (payload.type === "leave") {
            setDragging(false);
          } else if (payload.type === "drop") {
            setDragging(false);
            if (dropTarget.current.view === "browse" && payload.paths.length > 0) void runUpload(payload.paths);
          }
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
  }, [runUpload]);

  const toggleSelected = (node: FileNode) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(node.path)) next.delete(node.path);
      else next.set(node.path, node);
      return next;
    });
  };

  // Select every row the current filter leaves visible, and undo it in one go.
  const allSelected = rows.length > 0 && rows.every((node) => selected.has(node.path));
  const toggleSelectAll = () => {
    setSelected((prev) => {
      if (allSelected) return new Map();
      const next = new Map(prev);
      rows.forEach((node) => next.set(node.path, node));
      return next;
    });
  };

  /**
   * Paint selection: press a checkbox and drag over rows to select or deselect
   * everything passed. The intent is taken from the first row, so dragging from a
   * checked row clears as it goes.
   */
  const paint = useRef<{ want: boolean } | null>(null);
  const [painting, setPainting] = useState(false);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const listRef = useRef<HTMLDivElement>(null);

  const startPaint = (node: FileNode, event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const want = !selected.has(node.path);
    paint.current = { want };
    setPainting(true);
    setSelected((prev) => {
      const next = new Map(prev);
      if (want) next.set(node.path, node);
      else next.delete(node.path);
      return next;
    });
  };

  useEffect(() => {
    if (!painting) return;
    const list = listRef.current;
    const point = { x: 0, y: 0 };
    let dir = 0;

    const applyTo = (x: number, y: number) => {
      const current = paint.current;
      if (!current) return;
      const path = document.elementFromPoint(x, y)?.closest(".file-row")?.getAttribute("data-path");
      if (!path) return;
      setSelected((prev) => {
        const node = rowsRef.current.find((n) => n.path === path);
        if (!node || prev.has(path) === current.want) return prev;
        const next = new Map(prev);
        if (current.want) next.set(node.path, node);
        else next.delete(node.path);
        return next;
      });
    };

    const onMove = (event: PointerEvent) => {
      point.x = event.clientX;
      point.y = event.clientY;
      if (list) {
        // Hovering the last rows of a long folder should not require an extra
        // hand on the scrollbar, so the edge of the list takes over.
        const box = list.getBoundingClientRect();
        dir = event.clientY < box.top + 44 ? -1 : event.clientY > box.bottom - 44 ? 1 : 0;
      }
      applyTo(event.clientX, event.clientY);
    };

    // Painting keeps going while the pointer holds still at the edge, which is
    // how a drag from the top of a folder to the bottom actually ends up felt.
    let raf = 0;
    const loop = () => {
      if (dir !== 0 && list) {
        const before = list.scrollTop;
        const span = list.scrollHeight - list.clientHeight;
        list.scrollTop = Math.max(0, Math.min(span, before + dir * 10));
        if (list.scrollTop !== before) applyTo(point.x, point.y);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const stop = () => {
      paint.current = null;
      setPainting(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [painting]);

  // Moving is a two-step gesture: mark the files, walk to the folder, confirm.
  useEffect(() => {
    if (view !== "browse") setMoving(false);
  }, [view]);
  const confirmMove = async () => {
    const paths = [...selected.keys()];
    setMoving(false);
    setSelected(new Map());
    await onMovePaths(paths, browsePath);
  };

  const selectedSize = useMemo(() => [...selected.values()].reduce((sum, n) => sum + n.size, 0), [selected]);
  const selectedFiles = useMemo(() => [...selected.values()].filter((n) => n.type === "file"), [selected]);

  const runDelete = async () => {
    const paths = [...selected.keys()];
    setConfirming(false);
    setSelected(new Map());
    await onDeletePaths(paths);
  };

  const headerCell = (label: string, key?: SortKey, extra = "") => (
    <button
      disabled={!key}
      onClick={() => key && toggleSort(key)}
      className={`text-left text-[11px] font-semibold uppercase tracking-wider ${
        key ? "cursor-pointer hover:text-zinc-200" : "cursor-default"
      } ${sort.key === key ? "text-accent-400" : "text-zinc-500"} ${extra}`}
    >
      {label}
      {key && sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
    </button>
  );

  const grid = view === "category" ? GRID_CATEGORY : GRID_BROWSE;
  const space = opener.pendingSpace;

  return (
    <div className="flex flex-col h-full min-h-0 animate-fade-in-up">
      {/* Top bar */}
      <header className="flex items-center gap-3 px-5 py-3 border-b border-zinc-800/80 shrink-0">
        {view !== "home" && (
          <button
            onClick={() => { setView("home"); setSelected(new Map()); setQuery(""); }}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 cursor-pointer"
          >
            {t("view.backHome")}
          </button>
        )}
        {view === "home" && (
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-sm font-semibold text-zinc-200">SocketSweep</span>
          </div>
        )}
        <div className="flex items-center gap-3 text-xs min-w-0 flex-1 overflow-hidden">
          {capacity ? (
            <>
              <span className="text-zinc-500 shrink-0">{t("view.capacityTotal")} <span className="text-zinc-200 font-mono">{formatBytes(capacity.total_bytes)}</span></span>
              <span className="text-zinc-500 shrink-0">{t("view.capacityUsed")} <span className="text-zinc-200 font-mono">{formatBytes(capacity.used_bytes)}</span></span>
              <span className="text-zinc-500 shrink-0">{t("view.capacityFree")} <span className="text-emerald-400 font-mono">{formatBytes(capacity.free_bytes)}</span></span>
              <div className="flex-1 min-w-8 max-w-[220px]"><SizeBar ratio={capacity.used_bytes / capacity.total_bytes} /></div>
              <span className="text-zinc-400 font-mono shrink-0">{percent(capacity.used_bytes, capacity.total_bytes)}</span>
            </>
          ) : (
            <span className="text-zinc-600 shrink-0">{t("view.noCapacity")}</span>
          )}
          <span className="text-zinc-600 shrink-0 ml-auto">{t("view.scanned", { count: formatNumber(data.total_files), size: formatBytes(data.total_size) })}</span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <IconButton id="btn-downloads" label={t("transfer.title")} onClick={() => setDownloadsOpen(true)}>
            <IconDownload />
            {opener.queue.some((item) => item.state === "active" || item.state === "queued") && (
              <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-1 rounded-full bg-accent-500 text-white text-[10px] font-mono flex items-center justify-center">
                {opener.queue.filter((item) => item.state === "active" || item.state === "queued").length}
              </span>
            )}
          </IconButton>
          <IconButton id="btn-rescan" label={t("view.rescanShort")} onClick={onRescan}>
            <IconRescan />
          </IconButton>
          <IconButton id="btn-disconnect" label={t("view.disconnect")} onClick={onDisconnect} danger>
            <IconDisconnect />
          </IconButton>
        </div>
      </header>

      {/* Path row — where you are right now */}
      {view === "browse" && (
        <div className="px-5 py-2 border-b border-zinc-800/60 shrink-0 text-sm font-mono text-zinc-500 flex items-center gap-2 min-w-0">
          <button
            id="btn-up"
            onClick={() => parentPath && openFolder(parentPath)}
            disabled={!parentPath}
            title={parentPath ? t("view.up") : t("view.atRoot")}
            aria-label={t("view.up")}
            className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer"
          >
            <IconBack />
          </button>
          <div className="flex items-center min-w-0 overflow-x-auto">
            {crumbs.map((c, i) => (
              <span key={c.path} className="inline-flex items-center shrink-0">
                <button onClick={() => openFolder(c.path)} className={`hover:text-zinc-300 cursor-pointer ${i === crumbs.length - 1 ? "text-zinc-100 font-semibold" : ""}`}>
                  {c.name}
                </button>
                {i < crumbs.length - 1 && <span className="mx-1.5 opacity-50">&gt;</span>}
              </span>
            ))}
          </div>
        </div>
      )}
      {view === "category" && (
        <div className="px-5 py-2 border-b border-zinc-800/60 shrink-0 text-sm flex items-center gap-2">
          <span className="font-mono text-zinc-100 font-semibold">{categoryLabel(t, category)}</span>
          <span className="text-xs text-zinc-600">{t("view.everyFolder")}</span>
        </div>
      )}

      {flowError && (
        <div className="px-5 pt-3 shrink-0 flex justify-center">
          <div className="w-full max-w-md">
            <div className="rounded-xl border border-danger-500/40 bg-danger-500/5 p-3">
              <div className="flex items-start gap-2.5">
                <span className="text-danger-400 text-sm mt-0.5">✕</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-300 leading-relaxed break-words">{say(t, flowError.message, flowError.params)}</p>
                  {flowError.hints.map((h, i) => <p key={i} className="text-xs text-zinc-500 mt-1">· {say(t, h)}</p>)}
                </div>
                <button onClick={onDismissError} className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer">{t("common.known")}</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Search, transfer progress and the upload entry — pinned, so scrolling the
          list never takes them out of reach or shifts them around. */}
      {(view === "browse" || view === "category") && (
        <div className="px-5 py-2.5 border-b border-zinc-800/60 shrink-0 flex items-center gap-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t(view === "category" ? "view.searchCategory" : "view.searchFolder")}
            className="w-64 max-w-[40%] shrink-0 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-accent-500/50"
          />
          <span className="text-xs text-zinc-600 shrink-0">{t("view.items", { count: formatNumber(rows.length) })}</span>
          <div className="flex-1 min-w-0 flex items-center gap-2">
            {opener.pull && (
              <>
                <div className="flex-1 min-w-6 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                  <div
                    className="h-full bg-accent-500 transition-[width] duration-200"
                    style={{ width: `${Math.round((opener.pull.done / Math.max(1, opener.pull.total)) * 100)}%` }}
                  />
                </div>
                <span className="text-[11px] font-mono text-zinc-500 shrink-0">
                  {Math.round((opener.pull.done / Math.max(1, opener.pull.total)) * 100)}%
                </span>
              </>
            )}
            {opener.busy && (
              <button
                id="btn-cancel-transfer"
                onClick={opener.cancelTransfer}
                title={t("transfer.cancelNote")}
                className="ml-auto px-2.5 py-1 rounded-md text-[11px] font-medium text-zinc-400 hover:text-zinc-100 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700/50 cursor-pointer shrink-0"
              >
                {t("transfer.cancel")}
              </button>
            )}
          </div>
          {rows.length > 0 && (
            <button
              id="btn-select-all"
              onClick={toggleSelectAll}
              title={t(allSelected ? "view.deselectListed" : "view.selectListed", { count: formatNumber(rows.length) })}
              className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer shrink-0"
            >
              {t(allSelected ? "view.deselectAll" : "view.selectAll")}
            </button>
          )}
          {selected.size > 0 && (
            <button onClick={() => { setSelected(new Map()); setMoving(false); }} className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer shrink-0">
              {t("view.clearSelection")}
            </button>
          )}
          {view === "browse" && (
            <button
              id="btn-upload"
              onClick={() => void pickUpload()}
              title={t("view.uploadTo", { path: browsePath })}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-zinc-100 border border-zinc-700/50 cursor-pointer shrink-0"
            >
              <IconUpload />
              {t("view.upload")}
            </button>
          )}
        </div>
      )}

      <div ref={listRef} className={`flex-1 min-h-0 overflow-y-auto ${painting ? "select-none" : ""}`}>
        {view === "home" && (
          <div className="px-5 py-4 flex flex-col gap-4">
            {/* ① Treemap of level-1 folders */}
            <section>
              <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">{t("view.treemapTitle")}</h2>
              <div className="glass-card rounded-xl p-2 h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <Treemap
                    data={treemapData}
                    dataKey="size"
                    aspectRatio={4 / 3}
                    content={<TreemapCell />}
                    isAnimationActive={false}
                    onClick={(e: any) => { if (e?.path && e.path !== data.tree.path) openFolder(e.path); }}
                  >
                    <RechartsTooltip
                      content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const p = payload[0].payload as { name: string; size: number };
                        return (
                          <div className="bg-zinc-900 border border-zinc-800 p-2 rounded shadow-xl text-xs">
                            <p className="font-semibold text-zinc-200">{p.name}</p>
                            <p className="text-zinc-400 font-mono mt-1">{t("view.ofDisk", { size: formatBytes(p.size), pct: percent(p.size, denominator) })}</p>
                            <p className="text-zinc-600 mt-1">{t("view.treemapHint")}</p>
                          </div>
                        );
                      }}
                    />
                  </Treemap>
                </ResponsiveContainer>
              </div>
            </section>

            {/* ② Category cards */}
            <section>
              <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">{t("view.byType")}</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {CATEGORY_ORDER.map((key) => {
                  const bucket = buckets.get(key)!;
                  return (
                    <button
                      key={key}
                      onClick={() => { setCategory(key); setView("category"); setSelected(new Map()); setQuery(""); setSort({ key: "size", desc: true }); }}
                      className="glass-card rounded-xl px-4 py-3 text-left hover:border-accent-500/40 transition-colors cursor-pointer group"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <TypeGlyph kind={key === "other" ? "unknown" : key} size={22} />
                          <span className="text-sm text-zinc-300">{categoryLabel(t, key)}</span>
                        </span>
                        <span className="text-[11px] text-zinc-600 font-mono group-hover:text-accent-400">{t("view.open")}</span>
                      </div>
                      <div className="mt-1 text-lg font-bold font-mono text-zinc-100">{formatBytes(bucket.size)}</div>
                      <div className="text-[11px] text-zinc-600 font-mono">{t("view.typeStat", { count: formatNumber(bucket.files.length), pct: percent(bucket.size, denominator) })}</div>
                      <div className="mt-2"><SizeBar ratio={bucket.size / (denominator || 1)} /></div>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* ③ All files entry */}
            <section>
              <button
                onClick={() => { setBrowsePath(data.tree.path); setView("browse"); setSelected(new Map()); setQuery(""); }}
                className="w-full glass-card rounded-xl px-5 py-4 flex items-center gap-4 text-left hover:border-accent-500/40 transition-colors cursor-pointer"
              >
                <TypeGlyph kind="folder" size={40} />
                <span className="flex-1">
                  <span className="block text-sm font-semibold text-zinc-200">{t("view.allFiles")}</span>
                  <span className="block text-xs text-zinc-500 mt-0.5">
                    {t("view.allFilesNote")}
                  </span>
                </span>
                <span className="text-2xl font-bold font-mono text-accent-400">{formatBytes(data.total_size)}</span>
                <span className="text-zinc-500">→</span>
              </button>
            </section>
          </div>
        )}

        {(view === "browse" || view === "category") && (
          <div className="px-5 py-3">
            <div className="grid items-center gap-3 px-3 py-2 border-b border-zinc-800/80 sticky top-0 bg-surface-0/95 backdrop-blur" style={{ gridTemplateColumns: grid }}>
              <span />
              {headerCell(t("col.name"))}
              {headerCell(t("col.size"), "size")}
              {headerCell(t("col.share"))}
              {view === "browse" ? headerCell(t("col.counts")) : headerCell(t("col.mtime"), "mtime")}
              {view === "browse" ? headerCell(t("col.mtime"), "mtime") : headerCell(t("col.where"))}
              <span />
            </div>

            {rows.length === 0 && (
              <p className="text-sm text-zinc-600 py-8 text-center">{t("view.noMatches")}</p>
            )}

            {rows.slice(0, shown).map((node) => {
              const isDir = node.type === "directory";
              const stats = isDir ? subtreeStats(node) : null;
              const checked = selected.has(node.path);
              const cached = !isDir && opener.isCached(node);
              return (
                <div
                  key={node.path}
                  data-path={node.path}
                  onClick={() => (isDir ? openFolder(node.path) : toggleSelected(node))}
                  onDoubleClick={() => !isDir && opener.openFile(node)}
                  title={t(isDir ? "row.dirHint" : "row.fileHint")}
                  className={`grid items-center gap-3 px-3 py-1.5 rounded-md file-row cursor-pointer ${checked ? "bg-accent-500/10" : ""} ${moving && checked ? "opacity-35" : ""}`}
                  style={{ gridTemplateColumns: grid }}
                >
                  <TypeIcon node={node} />
                  <div className="min-w-0">
                    <div className={`text-sm truncate flex items-center gap-2 ${isDir ? "text-zinc-200 font-medium" : "text-zinc-400"}`}>
                      <span className="truncate">{node.name}</span>
                      {cached && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 shrink-0">
                          {t("row.cached")}
                        </span>
                      )}
                    </div>
                    {view === "browse" && (
                      <div className="text-[11px] text-zinc-600 truncate">{node.path}</div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="text-xs font-mono text-zinc-300">{formatBytes(node.size)}</span>
                    <SizeBar ratio={node.size / (denominator || 1)} />
                  </div>
                  <span className="text-xs font-mono text-zinc-500">{percent(node.size, denominator)}</span>
                  {view === "browse"
                    ? <span className="text-xs font-mono text-zinc-500">{stats ? `${formatNumber(stats.files)} / ${formatNumber(stats.dirs)}` : ""}</span>
                    : <span className="text-xs font-mono text-zinc-500">{formatDate(node.mtime, lang)}</span>}
                  {view === "browse"
                    ? <span className="text-xs font-mono text-zinc-500">{formatDate(node.mtime, lang)}</span>
                    : (
                      <span className="text-xs text-zinc-600 truncate" title={node.path}>
                        {node.path.slice(0, node.path.lastIndexOf("/"))}
                      </span>
                    )}
                  <span
                    onPointerDown={(e) => startPaint(node, e)}
                    onClick={(e) => e.stopPropagation()}
                    title={t(checked ? "row.uncheckHint" : "row.checkHint")}
                    className="h-10 -my-2 flex items-center justify-center rounded-md cursor-pointer hover:bg-zinc-700/40 touch-none select-none"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      readOnly
                      tabIndex={-1}
                      className="w-[18px] h-[18px] accent-teal-500 pointer-events-none"
                    />
                  </span>
                </div>
              );
            })}

            {rows.length > shown && (
              <button
                onClick={() => setShown((s) => s + 500)}
                className="w-full py-3 text-xs text-accent-400 hover:text-accent-300 cursor-pointer"
              >
                {t("view.loadMore", { shown: formatNumber(shown), total: formatNumber(rows.length) })}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Selection bar */}
      {selected.size > 0 && (
        <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/95 backdrop-blur px-5 py-3 flex items-center gap-4">
          {moving ? (
            <>
              <span className="text-sm text-accent-300 shrink-0">{t("sel.moveTo", { count: selected.size })}</span>
              <span className="text-sm font-mono text-zinc-200 truncate flex-1 min-w-0" title={browsePath}>{browsePath}</span>
              <span className="text-[11px] text-zinc-600 shrink-0">{t("sel.noOverwrite")}</span>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setMoving(false)}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 cursor-pointer"
                >
                  {t("common.cancel")}
                </button>
                <button
                  id="btn-move-here"
                  onClick={() => void confirmMove()}
                  className="px-4 py-2 rounded-lg text-sm font-bold bg-gradient-to-r from-accent-600 to-accent-500 text-white hover:from-accent-500 hover:to-accent-400 cursor-pointer"
                >
                  {t("sel.moveHere")}
                </button>
              </div>
            </>
          ) : (
            <>
              <span className="text-sm text-zinc-300">{t("sel.countPrefix")} <span className="font-mono text-accent-400">{selected.size}</span> {t("sel.countSuffix")}</span>
              <span className="text-sm text-zinc-500">{t("sel.total")} <span className="font-mono text-zinc-200">{formatBytes(selectedSize)}</span></span>
              {selectedFiles.length > 0 && (
                <span className="text-xs text-zinc-600">{t("sel.downloadable", { count: selectedFiles.length })}</span>
              )}
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => {
                    setDownloadsOpen(true);
                    void opener.downloadFiles([...selected.values()]);
                    // The queue now lives in the downloads panel, so the ticks have
                    // done their job and only get in the way.
                    setSelected(new Map());
                  }}
                  disabled={selectedFiles.length === 0 || opener.busy}
                  title={t(selectedFiles.length === 0 ? "sel.noneDownloadable" : "sel.downloadHint")}
                  className="px-4 py-2 rounded-lg text-sm font-semibold bg-zinc-800 text-accent-400 border border-accent-500/30 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {opener.busy ? t("sel.transferring") : t("sel.download")}
                </button>
                {view === "browse" && (
                  <button
                    id="btn-move"
                    onClick={() => setMoving(true)}
                    title={t("sel.moveHint")}
                    className="px-4 py-2 rounded-lg text-sm font-semibold bg-zinc-800 text-zinc-200 border border-zinc-700 hover:bg-zinc-700 cursor-pointer"
                  >
                    {t("sel.move")}
                  </button>
                )}
                <button
                  onClick={() => setConfirming(true)}
                  className="px-4 py-2 rounded-lg text-sm font-bold bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-500/20 cursor-pointer"
                >
                  {t("sel.delete")}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* The volume cannot hold what is about to be transferred, so ask first.
          Above the transfer panel (z-110), which opens in the same gesture. */}
      {space && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 max-w-lg w-full shadow-2xl animate-fade-in-up">
            <h3 className="text-lg font-bold text-zinc-100 mb-1">
              {t("space.title", { scope: t(space.scope === "pc" ? "space.pc" : "space.phone") })}
            </h3>
            <p className="text-sm text-zinc-500 mb-4 leading-relaxed">
              {t(space.scope === "pc" ? "space.pcNote" : "space.phoneNote")}
            </p>
            <dl className="rounded-lg border border-zinc-800 bg-zinc-950 divide-y divide-zinc-800/70 text-sm mb-4">
              <div className="flex gap-3 px-3 py-2">
                <dt className="w-24 shrink-0 text-zinc-600">{t("space.need")}</dt>
                <dd className="text-zinc-200 font-mono">
                  {formatBytes(space.need)}
                  <span className="text-zinc-600 text-xs ml-2">{t("space.items", { count: space.items })}</span>
                </dd>
              </div>
              <div className="flex gap-3 px-3 py-2">
                <dt className="w-24 shrink-0 text-zinc-600">{t(space.scope === "pc" ? "space.freePc" : "space.freePhone")}</dt>
                <dd className="text-danger-400 font-mono">{formatBytes(space.free)}</dd>
              </div>
              <div className="flex gap-3 px-3 py-2">
                <dt className="w-24 shrink-0 text-zinc-600">{t("space.where")}</dt>
                <dd className="text-zinc-300 font-mono text-xs break-all">{space.where}</dd>
              </div>
            </dl>
            <p className="text-xs text-zinc-500 leading-relaxed mb-5">
              {t(space.scope === "pc" ? "space.pcFix" : "space.phoneFix")}
            </p>
            <div className="flex items-center gap-3 justify-end">
              <button onClick={opener.cancelSpace} className="px-4 py-2 rounded-lg text-sm font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 cursor-pointer">
                {t("common.cancelEsc")}
              </button>
              <button
                onClick={opener.confirmSpace}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-zinc-800 text-zinc-200 border border-zinc-700 hover:bg-zinc-700 cursor-pointer"
              >
                {t("common.tryAnyway")}
              </button>
            </div>
          </div>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-[95] flex items-center justify-center bg-black/55 backdrop-blur-[2px]">
          <div className="rounded-2xl border-2 border-dashed border-accent-500/70 bg-zinc-900/95 px-8 py-6 text-center shadow-2xl">
            <p className="text-sm font-semibold text-zinc-100">{t("drop.title")}</p>
            <p className="mt-1.5 text-xs text-zinc-400 font-mono break-all max-w-md">{browsePath}</p>
            <p className="mt-2 text-[11px] text-zinc-600">{t("drop.note")}</p>
          </div>
        </div>
      )}

      {downloadsOpen && (
        <DownloadsPanel
          queue={opener.queue}
          onOpenFolder={() => void callBackend("reveal_folder", { kind: "download" }).catch(() => undefined)}
          onCancel={opener.cancelTransfer}
          onClear={opener.clearQueue}
          onClose={() => setDownloadsOpen(false)}
        />
      )}

      {/* Confirm dialog */}
      {confirming && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 max-w-lg w-full shadow-2xl animate-fade-in-up">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-500/10 flex items-center justify-center text-red-500 text-sm">🗑</div>
              <h3 className="text-lg font-bold text-zinc-100">{t("confirm.title", { count: selected.size })}</h3>
            </div>
            <p className="text-sm text-zinc-400 mb-3 leading-relaxed">
              {t("confirm.note")}
            </p>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950 divide-y divide-zinc-800/70 mb-5 max-h-64 overflow-y-auto">
              {[...selected.values()].slice(0, 20).map((n) => {
                const s = n.type === "directory" ? subtreeStats(n) : { files: 1, dirs: 0 };
                return (
                  <div key={n.path} className="px-3 py-2 flex items-start gap-3">
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs font-mono text-zinc-300 break-all">{n.path}</span>
                      <span className="block text-[11px] text-zinc-600 mt-0.5">
                        {formatBytes(n.size)} · {t("confirm.filesN", { count: formatNumber(s.files) })}
                        {n.type === "directory" ? ` · ${t("confirm.dirsN", { count: formatNumber(s.dirs) })}` : ""}
                      </span>
                    </span>
                  </div>
                );
              })}
              {selected.size > 20 && (
                <div className="px-3 py-2 text-xs text-zinc-600">{t("confirm.more", { count: selected.size - 20 })}</div>
              )}
            </div>
            <div className="flex items-center gap-3 justify-end">
              <button onClick={() => setConfirming(false)} className="px-4 py-2 rounded-lg text-sm font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 cursor-pointer">
                {t("common.cancelEsc")}
              </button>
              <button onClick={runDelete} className="px-4 py-2 rounded-lg text-sm font-bold bg-red-600 hover:bg-red-500 text-white cursor-pointer">
                {t("confirm.go", { size: formatBytes(selectedSize) })}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Treemap cell ────────────────────────────────────────────────────────────

const TREEMAP_COLORS = ["#0d9488", "#0284c7", "#4f46e5", "#7c3aed", "#c026d3", "#e11d48", "#ea580c", "#ca8a04"];

function TreemapCell(props: any) {
  const { x, y, width, height, index, name, value } = props;
  if (width < 24 || height < 24) {
    return <rect x={x} y={y} width={width} height={height} fill={TREEMAP_COLORS[index % TREEMAP_COLORS.length]} style={{ stroke: "var(--treemap-gap)" }} />;
  }
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} fill={TREEMAP_COLORS[index % TREEMAP_COLORS.length]} strokeWidth={1.5} style={{ stroke: "var(--treemap-gap)" }} />
      <text x={x + 6} y={y + 16} fill="#fff" fontSize={11} stroke="#0b0b0d" strokeWidth={2.5} strokeLinejoin="round" style={{ fontWeight: 600, paintOrder: "stroke" }}>{name}</text>
      {height > 40 && (
        <text x={x + 6} y={y + 30} fill="#e2e8f0" fontSize={9} stroke="#0b0b0d" strokeWidth={2} strokeLinejoin="round" style={{ fontFamily: "monospace", paintOrder: "stroke" }}>{formatBytes(value)}</text>
      )}
    </g>
  );
}
