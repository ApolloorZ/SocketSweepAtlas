import { createContext, useContext, useMemo } from "react";
import { MESSAGES } from "./messages";

export type Lang = "zh" | "en";
export type Params = Record<string, string | number>;
export type T = (key: string, params?: Params) => string;

/** Both languages are always written together, so an entry cannot go missing in
 *  one of them the way two separate dictionaries would. */
export interface I18n {
  lang: Lang;
  t: T;
}

const zhOnly = (lang: Lang) => (lang === "en" ? 1 : 0);

export function translate(lang: Lang, key: string, params?: Params): string {
  const pair = MESSAGES[key];
  if (!pair) return key;
  let text = pair[zhOnly(lang)];
  // English needs one form for one item and another for the rest. `{p:singular|plural}`
  // sits inside the sentence, so only the noun changes form.
  if (params && text.includes("{p:")) {
    text = text.replace(/\{p:([^}|]*)\|([^}]*)\}/g, (_all, one: string, many: string) =>
      Number(params.count) === 1 ? one : many
    );
  }
  if (!params) return text;
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (all, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : all
  );
}

export const LANGUAGE_CHOICES: { value: Lang; label: string }[] = [
  // Each language names itself; that label never needs translating.
  { value: "zh", label: "简体中文" },
  { value: "en", label: "English" },
];

export function useI18nValue(lang: Lang): I18n {
  return useMemo(() => ({ lang, t: (key: string, params?: Params) => translate(lang, key, params) }), [lang]);
}

/** Chinese is what the app shipped as, so a panel rendered outside the provider
 *  still reads correctly instead of showing raw keys. */
const DEFAULT_I18N: I18n = { lang: "zh", t: (key, params) => translate("zh", key, params) };

export const I18nContext = createContext<I18n>(DEFAULT_I18N);

export function useI18n(): I18n {
  return useContext(I18nContext);
}

export function useT(): T {
  return useI18n().t;
}

/**
 * Anything the Rust side wants said to the user comes back as `E#code` or
 * `E#code#argument` so the wording can follow the language the user picked.
 * Everything else — raw adb output, a JS error — is shown as it arrived, since
 * those are already English and are meant for whoever reads a log.
 */
export function backendText(t: T, raw: string): string {
  if (!raw.startsWith("E#")) return raw;
  const cut = raw.indexOf("#", 2);
  const code = cut < 0 ? raw.slice(2) : raw.slice(2, cut);
  const arg = cut < 0 ? "" : raw.slice(cut + 1);
  const key = `be.${code}`;
  const text = t(key, arg ? { arg } : undefined);
  // An unknown code means the two sides disagree; better to show what came back.
  return text === key ? raw : text;
}

export function backendError(t: T, err: unknown): string {
  return backendText(t, err instanceof Error ? err.message : String(err));
}

/**
 * One entry point for anything the app prints: a dictionary key, an `E#code`
 * from the Rust side, or plain text that is already readable (adb output, a JS
 * error). The last kind comes back untouched, which is what makes it safe to
 * route every log line and toast through here.
 */
export function say(t: T, text: string, params?: Params): string {
  if (text.startsWith("E#")) return backendText(t, text);
  return t(text, params);
}

/**
 * Dictionary text may wrap a phrase in `*stars*` so each language can put the
 * emphasis where its own word order wants it. Call sites map the parts to
 * elements; keeping this JSX-free lets plain modules use it too.
 */
export function richParts(text: string): { s: string; em: boolean }[] {
  return text.split("*").map((s, i) => ({ s, em: i % 2 === 1 }));
}
