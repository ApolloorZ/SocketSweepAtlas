import { useEffect, useRef, useState, type ReactNode } from "react";
import type { FileNode } from "./types";
import { cachedThumb, thumbFor } from "./thumbs";

/**
 * The icon slot of an image row. Nothing is asked for until the row is nearly on
 * screen, and a preview that arrived stays for the rest of the session, so
 * scrolling back is free. Without a preview the file type icon stays.
 */
export function Thumb({ node, size = 28, fallback }: { node: FileNode; size?: number; fallback: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(() => cachedThumb(node.path));

  useEffect(() => {
    const known = cachedThumb(node.path);
    setSrc(known);
    if (known) return;
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const seen = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        seen.disconnect();
        void thumbFor(node).then((url) => {
          if (alive && url) setSrc(url);
        });
      },
      // Start a little early so the icon is usually there before the row is.
      { rootMargin: "240px 0px" }
    );
    seen.observe(el);
    return () => {
      alive = false;
      seen.disconnect();
    };
  }, [node]);

  return (
    <span ref={ref} className="shrink-0 overflow-hidden rounded-md" style={{ width: size, height: size }}>
      {src ? (
        <img src={src} alt="" width={size} height={size} className="w-full h-full object-cover" />
      ) : (
        fallback
      )}
    </span>
  );
}
