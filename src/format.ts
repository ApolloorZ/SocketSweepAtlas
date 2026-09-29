import type { Lang } from "./i18n";

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * This year reads as a bare month/day, anything older needs the year. English
 * uses `Intl` so the month name follows its own conventions instead of being
 * translated word for word.
 */
export function formatDate(seconds: number | undefined, lang: Lang): string {
  if (!seconds) return "—";
  const d = new Date(seconds * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  if (sameYear) {
    return lang === "zh"
      ? `${d.getMonth() + 1}月${d.getDate()}日`
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function percent(part: number, whole: number): string {
  if (whole <= 0) return "—";
  const p = (part / whole) * 100;
  if (p > 0 && p < 0.1) return "<0.1%";
  return `${p.toFixed(1)}%`;
}
