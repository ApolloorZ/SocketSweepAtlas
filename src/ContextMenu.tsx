import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n, type Params } from "./i18n";

export interface MenuItem {
  /** Dictionary key for the label. */
  label: string;
  params?: Params;
  /** Absent means: shown so the menu reads complete, but not wired yet. */
  onSelect?: () => void;
  danger?: boolean;
  /** Dictionary key for the greyed note on the right, e.g. "coming next". */
  note?: string;
}

/**
 * A popup menu shaped like the one in Windows Explorer: it opens under the
 * cursor, never runs off the edge of the window, and closes on Escape, on a
 * click anywhere outside it, or as soon as an item is taken.
 *
 * Items without a handler are still listed — greyed, with a note — because a
 * half-populated menu is what makes the whole thing feel unfinished.
 */
export function ContextMenu({
  x,
  y,
  title,
  subtitle,
  items,
  onDismiss,
}: {
  x: number;
  y: number;
  title: string;
  subtitle?: string;
  items: MenuItem[];
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // The first paint happens at the cursor, then the real size is known and the
  // menu is pulled back inside the window.
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPos({
      x: Math.max(6, Math.min(x, window.innerWidth - box.width - 6)),
      y: Math.max(6, Math.min(y, window.innerHeight - box.height - 6)),
    });
  }, [x, y, items.length]);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    // Any other wheel/scroll movement would leave the menu hanging in mid-air.
    const onScroll = () => onDismiss();
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onDismiss]);

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-[228px] rounded-lg border border-zinc-700/80 bg-surface-0 py-1 shadow-2xl animate-fade-in-up"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="px-3 pt-1.5 pb-2 border-b border-zinc-800/80 mb-1">
        <div className="text-xs text-zinc-300 truncate max-w-[260px]">{title}</div>
        {subtitle && <div className="text-[11px] text-zinc-600 mt-0.5">{subtitle}</div>}
      </div>
      {items.map((item, i) => {
        const live = !!item.onSelect;
        return (
          <button
            key={i}
            role="menuitem"
            disabled={!live}
            onClick={() => {
              item.onSelect?.();
              onDismiss();
            }}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] cursor-pointer ${
              live ? "text-zinc-300 hover:bg-accent-500/20 hover:text-zinc-100" : "text-zinc-600 cursor-default"
            } ${item.danger && live ? "text-red-400 hover:bg-red-500/15 hover:text-red-300" : ""}`}
          >
            <span className="flex-1 truncate">{t(item.label, item.params)}</span>
            {item.note && <span className="text-[10px] text-zinc-600 shrink-0">{t(item.note)}</span>}
          </button>
        );
      })}
    </div>
  );
}
