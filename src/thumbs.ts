import { callBackend, isMockMode } from "./backend";
import type { FileNode } from "./types";

/**
 * Phone JPEGs keep a small preview inside their own header (the EXIF thumbnail),
 * so a row icon can be filled by reading a few dozen kilobytes instead of pulling
 * a 5 MB picture across adb. Anything small enough to just take is taken whole,
 * which also covers PNG and GIF.
 */
const HEAD_BYTES = 64 * 1024;
const WHOLE_FILE_BYTES = 512 * 1024;

/** adb round trips are not free, and a folder of photos would otherwise fire a
 *  hundred at once the moment it is opened. */
const MAX_PARALLEL = 2;

const urls = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();
const slots: (() => void)[] = [];
let running = 0;

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

  const job = (async () => {
    if (isMockMode) {
      const url = mockThumb(node);
      if (url) urls.set(node.path, url);
      return url || null;
    }
    await takeSlot();
    try {
      const whole = node.size > 0 && node.size <= WHOLE_FILE_BYTES;
      const limit = whole ? WHOLE_FILE_BYTES : HEAD_BYTES;
      const head = base64ToBytes(await callBackend<string>("peek_file", { devicePath: node.path, limit }));
      const bytes = whole ? head : exifThumbnail(head);
      if (!bytes || bytes.length < 512) return null;
      // A data: URI, not URL.createObjectURL: the packaged app's CSP allows
      // `img-src 'self' data:` and blocks blob:, which dev mode never shows.
      const url = `data:${mimeFor(node.name)};base64,${bytesToBase64(bytes)}`;
      urls.set(node.path, url);
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
