import { useEffect, type ReactNode } from "react";

export function IconClose() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
      <path d="M3.2 3.2l7.6 7.6M10.8 3.2l-7.6 7.6" />
    </svg>
  );
}

/**
 * The shell every modal panel shares: dimmed backdrop, one card, a sticky header
 * with an actions slot and a close button, and Esc to dismiss.
 *
 * The scroller carries `scroll-inset` so the scrollbar thumb stops short of the
 * card's rounded corners instead of poking past them at either end.
 */
export function Panel({
  title,
  actions,
  wide,
  onClose,
  children,
}: {
  title: string;
  actions?: ReactNode;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div
        className={`bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl animate-fade-in-up max-h-[90vh] overflow-y-auto scroll-inset ${
          wide ? "w-full max-w-2xl" : "w-full max-w-xl"
        }`}
      >
        <div className="flex items-center gap-2 px-6 py-3.5 border-b border-zinc-800 sticky top-0 bg-zinc-900">
          <h3 className="text-base font-bold text-zinc-100 flex-1">{title}</h3>
          {actions}
          <button
            onClick={onClose}
            title="关闭 (Esc)"
            aria-label="关闭"
            className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
          >
            <IconClose />
          </button>
        </div>
        <div className="px-6 py-4 flex flex-col gap-5">{children}</div>
      </div>
    </div>
  );
}
