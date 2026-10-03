import { callBackend, isMockMode } from "./backend";
import type { FileNode } from "./types";
import { axmlVersions, findEntryLazy, inflate, localDataOffset } from "./apkFormat";

/**
 * Which APKs are on the phone and what version each one declares.
 *
 * The parsing lives in `apkFormat.ts`; this file is only about paying for it:
 * three small byte-range reads per APK (tail for the zip index, the local
 * header, then the manifest itself), never more than two at a time, and the
 * answer kept on disk so the phone is asked once per file rather than once per
 * visit. A folder of installers is 20 MB of index reads at worst, and only for
 * the rows actually on screen.
 */
const KB = 1024;
const LOCAL_HEADER_BYTES = 64;
const MANIFEST_CAP = 512 * KB;
/** adb round trips are not free, so at most two APKs are opened at once. */
const MAX_PARALLEL = 2;

const versions = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
const queue: (() => void)[] = [];
let running = 0;

async function readRange(path: string, offset: number, limit: number): Promise<Uint8Array> {
  const text = await callBackend<string>("peek_file", { devicePath: path, limit, offset });
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function readVersion(node: FileNode): Promise<string | null> {
  const size = node.size;
  if (size < 32 * KB) return null;

  const entry = await findEntryLazy((offset, limit) => readRange(node.path, offset, limit), size, "AndroidManifest.xml");
  if (!entry) return null;
  if (entry.compressed === 0 || entry.local + 30 > size) return null;

  const head = await readRange(node.path, entry.local, LOCAL_HEADER_BYTES);
  const dataAt = localDataOffset(head);
  if (dataAt === null || entry.local + dataAt >= size) return null;

  const raw = await readRange(node.path, entry.local + dataAt, Math.min(entry.compressed, MANIFEST_CAP));
  if (raw.length === 0) return null;
  const xml = await inflate(raw, entry.method);
  return xml ? axmlVersions(xml) : null;
}

function takeSlot(): Promise<void> {
  if (running < MAX_PARALLEL) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => queue.push(resolve));
}

function freeSlot() {
  const next = queue.shift();
  if (next) next();
  else running -= 1;
}

/** Previews and versions share the disposable folder; the prefix keeps them apart. */
function cacheKey(node: FileNode): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(node.path)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return `apk-${(hash >>> 0).toString(16).padStart(8, "0")}-${node.size}-${node.mtime ?? 0}`;
}

export function cachedVersion(path: string): string | null | undefined {
  return versions.get(path);
}

export function isApk(node: FileNode): boolean {
  return node.type === "file" && node.name.toLowerCase().endsWith(".apk");
}

export async function versionFor(node: FileNode): Promise<string | null> {
  if (versions.has(node.path)) return versions.get(node.path) ?? null;
  if (isMockMode) return null;

  const known = inflight.get(node.path);
  if (known) return known;

  const task = (async () => {
    const key = cacheKey(node);
    try {
      const stored = await callBackend<string>("thumb_get", { key });
      // "none" was written by one interim build as a negative marker; it is not
      // an answer any more, so it reads as "nothing known" and the phone is asked.
      if (stored && stored !== "none") {
        versions.set(node.path, stored);
        return stored;
      }
    } catch {
      // A missing disk cache is not a reason to refuse; just read the phone.
    }

    await takeSlot();
    let value: string | null = null;
    try {
      value = await readVersion(node);
    } catch {
      value = null;
    } finally {
      freeSlot();
    }
    versions.set(node.path, value);
    // Only a real answer is worth keeping. A blank cell can mean "this APK
    // declares no version" or "I could not read it" and the two are not
    // distinguishable here, so an unread one must not be frozen into the cache
    // the way a missing preview legitimately is.
    if (value) callBackend("thumb_put", { key, value }).catch(() => undefined);
    return value;
  })();

  inflight.set(node.path, task);
  void task.finally(() => inflight.delete(node.path));
  return task;
}
