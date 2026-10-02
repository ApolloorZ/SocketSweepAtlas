import { callBackend, isMockMode } from "./backend";
import type { FileNode } from "./types";

/**
 * Phone JPEGs keep a small preview inside their own header (the EXIF thumbnail),
 * so a row icon can be filled by reading a few dozen kilobytes instead of pulling
 * a 5 MB picture across adb. Anything small enough to just take is taken whole,
 * which also covers PNG and GIF.
 *
 * A half-read image never renders, so a file bigger than `DECODE_CAP` is only
 * ever previewed from its EXIF block — plenty of app-generated images carry no
 * EXIF at all, and those honestly keep the type icon.
 */
const HEAD_BYTES = 64 * 1024;
const WHOLE_FILE_BYTES = 512 * 1024;
const DECODE_CAP = 2 * 1024 * 1024;

/** adb round trips are not free, and a folder of photos would otherwise fire a
 *  hundred at once the moment it is opened. */
const MAX_PARALLEL = 2;

const urls = new Map<string, string>();
/** Paths already known to have no preview, so the phone is not asked again. */
const missing = new Set<string>();
const inflight = new Map<string, Promise<string | null>>();
const slots: (() => void)[] = [];
let running = 0;

/**
 * Previews are kept on disk between runs, in their own folder. A stored entry is
 * keyed by path *and* size and mtime, so a photo edited on the phone cannot be
 * shown from an old capture.
 */
const MB = 1024 * 1024;
let limitBytes = 128 * MB;
let writes = 0;

export function setThumbLimit(mb: number): void {
  limitBytes = Math.max(0, mb) * MB;
}

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function cacheKey(node: FileNode): string {
  return `${fnv1a(node.path)}-${node.size}-${node.mtime ?? 0}`;
}

function store(key: string, value: string): void {
  callBackend("thumb_put", { key, value }).catch(() => undefined);
  writes += 1;
  // Trimming is cheap and the folder is disposable, so it happens as a side
  // effect of use rather than needing a scheduler of its own.
  if (writes % 24 === 0) {
    callBackend("trim_thumb_cache", { limitBytes, all: false }).catch(() => undefined);
  }
}

function takeSlot(): Promise<void> {
  if (running < MAX_PARALLEL) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => slots.push(resolve));
}

function freeSlot() {
  const next = slots.shift();
  if (next) next();
  else running -= 1;
}

function base64ToBytes(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  // Chunked because String.fromCharCode(...) spreads its argument over the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function read16(view: DataView, at: number, le: boolean) {
  return view.getUint16(at, le);
}

function read32(view: DataView, at: number, le: boolean) {
  return view.getUint32(at, le);
}

/**
 * Walks to the EXIF thumbnail and returns its bytes. Returns null for anything
 * that is not a JPEG, has no preview, or was cut off before the preview ended —
 * a half thumbnail is worse than the file type icon.
 */
export function exifThumbnail(head: Uint8Array): Uint8Array | null {
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);

  let at = 2;
  while (at + 4 < head.length) {
    if (head[at] !== 0xff) return null;
    const marker = head[at + 1];
    const size = read16(view, at + 2, false);
    if (marker === 0xda) return null; // start of the real picture: no preview here
    if (size < 2 || at + 2 + size > head.length) return null;
    if (marker === 0xe1) {
      const app1 = head.subarray(at + 4, at + 2 + size);
      const tiff = findExifTiff(app1);
      if (tiff) {
        const thumb = thumbnailInTiff(tiff);
        if (thumb) return thumb;
      }
    }
    at += 2 + size;
  }
  return null;
}

function findExifTiff(segment: Uint8Array): Uint8Array | null {
  // "Exif\0\0" then the TIFF block; some phones pad the APP1 with zeros first.
  for (let i = 0; i + 14 < segment.length; i++) {
    if (
      segment[i] === 0x45 && segment[i + 1] === 0x78 && segment[i + 2] === 0x69 &&
      segment[i + 3] === 0x66 && segment[i + 4] === 0 && segment[i + 5] === 0
    ) {
      return segment.subarray(i + 6);
    }
  }
  return null;
}

function thumbnailInTiff(tiff: Uint8Array): Uint8Array | null {
  if (tiff.length < 8) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;

  const ifdAt = read32(view, 4, le);
  const found = scanIfd(tiff, view, le, ifdAt);
  if (found) return found;
  // The preview normally lives in the IFD after IFD0.
  const next = ifdOffsetAfter(tiff, view, le, ifdAt);
  return next === null ? null : scanIfd(tiff, view, le, next);
}

/** Reads one IFD and returns the preview it points at, if any. */
function scanIfd(tiff: Uint8Array, view: DataView, le: boolean, ifdAt: number): Uint8Array | null {
  if (ifdAt <= 0 || ifdAt + 2 > tiff.length) return null;
  const count = read16(view, ifdAt, le);
  let offset = 0;
  let length = 0;
  for (let i = 0; i < count; i++) {
    const entry = ifdAt + 2 + i * 12;
    if (entry + 12 > tiff.length) return null;
    const tag = read16(view, entry, le);
    const value = read32(view, entry + 8, le);
    // 0x0201 says where the preview starts, 0x0202 how long it is; 0x8825 is the
    // pointer to that IFD when the preview sits one level deeper.
    if (tag === 0x0201) offset = value;
    if (tag === 0x0202) length = value;
    if (tag === 0x8825) {
      const deeper = scanIfd(tiff, view, le, value);
      if (deeper) return deeper;
    }
  }
  if (!offset || !length || offset + length > tiff.length) return null;
  return tiff.subarray(offset, offset + length);
}

function ifdOffsetAfter(tiff: Uint8Array, view: DataView, le: boolean, ifdAt: number): number | null {
  const count = read16(view, ifdAt, le);
  const at = ifdAt + 2 + count * 12;
  if (at + 4 > tiff.length) return null;
  return read32(view, at, le);
}

function mimeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  if (ext === "heic" || ext === "heif") return "image/heic";
  return "image/jpeg";
}

/** A phone folder is full of PNGs named .jpg; the bytes decide, not the suffix. */
function sniffMime(bytes: Uint8Array, name: string): string {
  const at = (i: number) => bytes[i];
  if (bytes.length > 12) {
    if (at(0) === 0x89 && at(1) === 0x50) return "image/png";
    if (at(0) === 0xff && at(1) === 0xd8) return "image/jpeg";
    if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return "image/gif";
    if (at(0) === 0x42 && at(1) === 0x4d) return "image/bmp";
    if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
        at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  }
  return mimeFor(name);
}

/** Mock mode has no phone to read, so it draws its own square instead. */
function mockThumb(node: FileNode): string {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  let hash = 0;
  for (const byte of new TextEncoder().encode(node.path)) hash = (hash * 31 + byte) & 0xffffff;
  ctx.fillStyle = `hsl(${hash % 360} 45% 38%)`;
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = "#fafafa";
  ctx.font = "bold 30px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(node.name.slice(0, 1).toUpperCase(), 32, 34);
  return canvas.toDataURL("image/jpeg", 0.8);
}

/** The answer for a file already fetched, without waiting on the promise. */
export function cachedThumb(path: string): string | null {
  return urls.get(path) ?? null;
}

/**
 * Fetches and caches a preview for one file. Resolves to null when there is
 * nothing to show, which is normal for formats that carry no embedded preview.
 */
export function thumbFor(node: FileNode): Promise<string | null> {
  const known = urls.get(node.path);
  if (known) return Promise.resolve(known);
  const started = inflight.get(node.path);
  if (started) return started;
  if (missing.has(node.path)) return Promise.resolve(null);

  const job = (async () => {
    const key = cacheKey(node);
    await takeSlot();
    try {
      // The disk cache answers two questions at once: a stored URL, or `none`
      // meaning "this file has no preview to be had" — so the phone is not
      // asked again for it on every visit.
      const stored = await callBackend<string>("thumb_get", { key }).catch(() => "");
      if (stored === "none") { missing.add(node.path); return null; }
      if (stored) { urls.set(node.path, stored); return stored; }

      if (isMockMode) {
        const drawn = mockThumb(node);
        if (drawn) { urls.set(node.path, drawn); store(key, drawn); }
        else missing.add(node.path);
        return drawn || null;
      }

      const size = node.size;
      let bytes: Uint8Array | null;
      if (size > 0 && size <= WHOLE_FILE_BYTES) {
        bytes = base64ToBytes(await callBackend<string>("peek_file", { devicePath: node.path, limit: WHOLE_FILE_BYTES }));
      } else {
        bytes = exifThumbnail(base64ToBytes(await callBackend<string>("peek_file", { devicePath: node.path, limit: HEAD_BYTES })));
        if (!bytes && size > 0 && size <= DECODE_CAP) {
          // No EXIF preview to dig out — a PNG wearing a .jpg name, say. The
          // only picture left is the file itself, so take it while it is small.
          bytes = base64ToBytes(await callBackend<string>("peek_file", { devicePath: node.path, limit: size }));
        }
      }
      if (!bytes || bytes.length < 512) {
        missing.add(node.path);
        store(key, "none");
        return null;
      }
      // A data: URI, not URL.createObjectURL: the packaged app's CSP allows
      // `img-src 'self' data:` and blocks blob:, which dev mode never shows.
      const url = `data:${sniffMime(bytes, node.name)};base64,${bytesToBase64(bytes)}`;
      urls.set(node.path, url);
      store(key, url);
      return url;
    } catch {
      // A file we cannot preview is not worth interrupting the list for.
      return null;
    } finally {
      inflight.delete(node.path);
      freeSlot();
    }
  })();

  inflight.set(node.path, job);
  return job;
}
