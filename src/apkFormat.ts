/**
 * Reading an APK's declared version out of the file itself.
 *
 * `versionName` is not in the file name and not in the directory listing — it
 * lives in `AndroidManifest.xml`, which inside an APK is a *binary* XML chunk
 * addressed from the zip index at the **end** of the file. So the cheap route
 * (read the head and look for text) does not exist: the index has to be found
 * first, then the manifest located through it, then the compiled XML decoded.
 *
 * Nothing here guesses. Every shape that is not exactly what the format
 * specifies returns null, and the caller leaves the cell empty — a plausible
 * but wrong version number would be worse than none at all.
 */
const u16 = (b: Uint8Array, at: number) => (at + 1 < b.length ? (b[at] | (b[at + 1] << 8)) >>> 0 : 0);
const u32 = (b: Uint8Array, at: number) =>
  (at + 3 < b.length ? (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0 : 0);

export interface ZipEntry {
  method: number;
  compressed: number;
  uncompressed: number;
  /** Offset of this entry's *local* header, which is where the data starts. */
  local: number;
}

/** `null` means "not in these bytes"; `"wider"` means the index did not fit. */
export type Found = ZipEntry | "wider" | null;

/**
 * Looks one name up in the zip central directory.
 *
 * `tail` holds the bytes from `tailAt` onwards, so the directory's absolute
 * offsets have to be rebased — and if the directory starts before the tail, the
 * caller needs a longer read rather than a partial walk.
 */
export function findEntry(tail: Uint8Array, tailAt: number, name: string): Found {
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const size = u32(tail, eocd + 12);
  const start = u32(tail, eocd + 16);
  if (start < tailAt || start + size > tailAt + tail.length) return "wider";

  let at = start - tailAt;
  const stop = Math.min(at + size, tail.length);
  while (at + 46 <= stop) {
    if (u32(tail, at) !== 0x02014b50) return null;
    const nameLen = u16(tail, at + 28);
    const extraLen = u16(tail, at + 30);
    const commentLen = u16(tail, at + 32);
    if (nameLen === name.length && at + 46 + nameLen <= tail.length) {
      let text = "";
      for (let i = 0; i < nameLen; i++) text += String.fromCharCode(tail[at + 46 + i]);
      if (text === name) {
        return {
          method: u16(tail, at + 10),
          compressed: u32(tail, at + 20),
          uncompressed: u32(tail, at + 24),
          local: u32(tail, at + 42),
        };
      }
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** Zip method 0 is stored, 8 is raw deflate — anything else is refused. */
export async function inflate(bytes: Uint8Array, method: number): Promise<Uint8Array | null> {
  if (method === 0) return bytes;
  if (method !== 8 || typeof DecompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Reads until the whole central directory fits in the window.
 *
 * The zip index sits at the end of the file, but how long it is depends on how
 * many entries the APK holds — a big app with thousands of assets has an index
 * far wider than the first guess, and a partial table must never be walked. So
 * the window doubles until the index fits, and gives up rather than reading the
 * entire package.
 */
export async function findEntryLazy(
  read: (offset: number, limit: number) => Promise<Uint8Array>,
  fileSize: number,
  name: string
): Promise<ZipEntry | null> {
  for (let window = 256 * 1024; window <= 2 * 1024 * 1024; window *= 2) {
    const at = Math.max(0, fileSize - window);
    const found = findEntry(await read(at, Math.min(window, fileSize - at)), at, name);
    if (found !== "wider") return found;
    if (at === 0) return null; // the whole file was already in the window
  }
  return null;
}

/** Offsets of a local file header's payload: fixed part, then name, then extra. */
export function localDataOffset(head: Uint8Array): number | null {
  if (head.length < 30 || u32(head, 0) !== 0x04034b50) return null;
  return 30 + u16(head, 26) + u16(head, 28);
}

/**
 * Reads `versionName` off the root element of a compiled AndroidManifest.
 *
 * The file is a flat run of chunks: one string pool holding every name, then
 * the tags. An attribute is a name index plus a typed value, and a string value
 * is itself another index into that pool — so both tables have to be walked, and
 * a pool that is not UTF-8 stores its strings as 16-bit units.
 */
export function axmlVersions(xml: Uint8Array): string | null {
  if (xml.length < 16 || u16(xml, 0) !== 0x0003) return null;

  let offsets: number[] = [];
  let stringsAt = 0;
  let utf8 = false;

  for (let chunk = u16(xml, 2); chunk + 8 <= xml.length; ) {
    const type = u16(xml, chunk);
    const header = u16(xml, chunk + 2);
    const size = u32(xml, chunk + 4);
    if (size < 8) return null;

    if (type === 0x0001) {
      const count = u32(xml, chunk + 8);
      utf8 = (u32(xml, chunk + 16) & 0x100) !== 0;
      stringsAt = chunk + u32(xml, chunk + 20);
      offsets = [];
      for (let i = 0; i < count && chunk + header + i * 4 + 3 < xml.length; i++) {
        offsets.push(u32(xml, chunk + header + i * 4));
      }
    } else if (type === 0x0102 && offsets.length > 0) {
      const string = (index: number): string | null => {
        if (index < 0 || index >= offsets.length) return null;
        let at = stringsAt + offsets[index];
        if (at < 0 || at >= xml.length) return null;
        if (utf8) {
          // A character count and then a byte count, each one byte or two.
          const width = (p: number) => ((xml[p] & 0x80) !== 0 ? 2 : 1);
          at += width(at);
          const bytes = width(at) === 2 ? ((xml[at] & 0x7f) << 8) | xml[at + 1] : xml[at];
          at += width(at);
          if (at + bytes > xml.length) return null;
          return new TextDecoder("utf-8").decode(xml.subarray(at, at + bytes));
        }
        const chars = u16(xml, at);
        at += 2;
        let text = "";
        for (let i = 0; i < chars && at + 1 < xml.length; i++, at += 2) text += String.fromCharCode(u16(xml, at));
        return text;
      };

      // ResXMLTree_attrExt sits after the chunk header, the line number and the
      // comment. Its own fields say where the attributes start, how wide each is
      // and how many there are — all three have to be read, because the version
      // pair is not in a fixed position and `versionCode` often comes first.
      const ext = chunk + 16;
      if (string(u32(xml, ext + 4)) !== "manifest") return null;
      const attrStart = u16(xml, ext + 8);
      const attrSize = u16(xml, ext + 10) || 20;
      const count = u16(xml, ext + 12);
      let name: string | null = null;
      let code: string | null = null;
      for (let i = 0; i < count; i++) {
        const attr = ext + attrStart + i * attrSize;
        if (attr + 20 > xml.length) break;
        const key = string(u32(xml, attr + 4));
        const dataType = xml[attr + 15];
        const data = u32(xml, attr + 16);
        if (key === "versionName" && dataType === 0x03) name = string(data);
        if (key === "versionCode" && dataType === 0x10) code = String(data >>> 0);
      }
      // The human-facing version is what a row should show; a build number is
      // the fallback, and an APK that declares neither stays blank.
      return name ?? code;
    }
    chunk += size;
  }
  return null;
}
