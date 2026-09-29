import { useCallback, useState } from "react";
import type { Lang } from "./i18n";

export type Theme = "dark" | "light";

export interface Settings {
  theme: Theme;
  /** Which language every label in the app is drawn in. */
  lang: Lang;
  /** Show the developer log strip without the user opening it first. */
  logsOpen: boolean;
  /** Cached copies older than the rest get dropped once the folder passes this. */
  cacheLimitMb: number;
  /** null = the platform's application cache folder. */
  cachePath: string | null;
  downloadPath: string | null;
  /** Empty the cache folder when the last window closes. */
  clearCacheOnExit: boolean;
  /** Tint a whole row by how much of the disk it holds. */
  rowShareBar: boolean;
  /** `#rrggbb`, as the colour picker produces it. */
  rowShareColor: string;
  /** Read a preview out of each image file and show it in its row. */
  thumbnails: boolean;
}

export const MB = 1024 * 1024;

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  lang: "zh",
  logsOpen: false,
  cacheLimitMb: 2048,
  cachePath: null,
  downloadPath: null,
  clearCacheOnExit: false,
  rowShareBar: true,
  rowShareColor: "#38bdf8",
  thumbnails: true,
};

const KEY = "ss-settings";

/** Anything handed to a CSS `color-mix` has to be a plain hex triple: a stored
 *  value edited by hand should not be able to put markup into a style. */
function hexColor(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : DEFAULT_SETTINGS.rowShareColor;
}

/**
 * Reads the stored settings. The theme lived under its own key before the
 * settings page existed, so that value still wins over the default.
 */
export function readSettings(): Settings {
  const legacyTheme = localStorage.getItem("ss-theme");
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    theme: legacyTheme === "light" ? "light" : "dark",
  };
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch {
    localStorage.removeItem(KEY);
  }
  settings.rowShareColor = hexColor(settings.rowShareColor);
  return settings;
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(readSettings);

  const patch = useCallback((changes: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...changes };
      localStorage.setItem(KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { settings, patch };
}
