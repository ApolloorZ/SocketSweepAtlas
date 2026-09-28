import { useCallback, useState } from "react";

export type Theme = "dark" | "light";

export interface Settings {
  theme: Theme;
  /** Show the developer log strip without the user opening it first. */
  logsOpen: boolean;
  /** Pulling a file bigger than this asks for confirmation first. */
  largeFileMb: number;
  /** Cached copies older than the rest get dropped once the folder passes this. */
  cacheLimitMb: number;
  /** null = the platform's application cache folder. */
  cachePath: string | null;
  downloadPath: string | null;
  /** Empty the cache folder when the last window closes. */
  clearCacheOnExit: boolean;
}

export const MB = 1024 * 1024;

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  logsOpen: false,
  largeFileMb: 300,
  cacheLimitMb: 2048,
  cachePath: null,
  downloadPath: null,
  clearCacheOnExit: false,
};

const KEY = "ss-settings";

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
