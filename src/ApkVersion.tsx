import { useEffect, useRef, useState } from "react";
import type { FileNode } from "./types";
import { cachedVersion, isApk, versionFor } from "./apkInfo";
import { useI18n } from "./i18n";

/**
 * The version cell of an APK row. Nothing is read from the phone until the row
 * is nearly on screen, and a version that arrived stays for the rest of the
 * session — reading an APK's index is three adb round trips, not a directory
 * entry. Other file types get an empty cell and cost nothing.
 */
export function ApkVersion({ node }: { node: FileNode }) {
  const { t } = useI18n();
  const ref = useRef<HTMLSpanElement>(null);
  const [text, setText] = useState<string | null | undefined>(() => cachedVersion(node.path));

  useEffect(() => {
    if (!isApk(node)) {
      setText(undefined);
      return;
    }
    const known = cachedVersion(node.path);
    if (known !== undefined) {
      setText(known);
      return;
    }
    const el = ref.current;
    if (!el) return;
    let alive = true;
    const seen = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        seen.disconnect();
        void versionFor(node).then((value) => {
          if (alive) setText(value);
        });
      },
      { rootMargin: "240px 0px" }
    );
    seen.observe(el);
    return () => {
      alive = false;
      seen.disconnect();
    };
  }, [node]);

  if (!isApk(node)) return <span ref={ref} className="text-zinc-600">—</span>;
  return (
    <span ref={ref} className="font-mono text-accent-400">
      {text ?? <span className="text-zinc-600">{text === undefined ? t("col.versionPending") : "—"}</span>}
    </span>
  );
}
