import type { Lang } from "./i18n";

const UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Keep existing 1024-based labels and precision for ordinary file sizes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "Unknown";
  if (bytes === 0) return "0 B";

  const sign = bytes < 0 ? "-" : "";
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }

  // Scientific notation preserves tiny nonzero values and bounds huge output.
  const amount = value < 0.1 || value >= 1e21
    ? value.toExponential(1)
    : value.toFixed(unit === 0 && Number.isInteger(value) ? 0 : 1);
  return `${sign}${amount} ${UNITS[unit]}`;
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
