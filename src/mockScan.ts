// Dev-only mock of the Tauri backend so the UI can be exercised in a plain
// browser (no device, no Rust). Tree-shaken out of production builds.

import type { FileNode, ScanResponse } from "./types";

let rngState = 20260927;
function rnd(): number {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}

// A spread of dates so "sort by modified time" is visibly meaningful.
function mockMtime(): number {
  const daysBack = Math.floor(rnd() * 900);
  return Math.floor(Date.now() / 1000) - daysBack * 86400;
}

function file(name: string, path: string, size: number): FileNode {
  return { name, path, type: "file", size, mtime: mockMtime() };
}

function dir(name: string, path: string, children: FileNode[]): FileNode {
  return {
    name,
    path,
    type: "directory",
    size: children.reduce((sum, c) => sum + c.size, 0),
    mtime: mockMtime(),
    children,
  };
}

/**
 * Files carry the path of the folder they sit in, exactly like the daemon does:
 * every tree operation in the app walks by path, so a fake `/mock/...` path that
 * does not match its parent makes moves and file deletes silently no-op here and
 * pass in the harness while they are broken on the phone.
 */
/**
 * Every bucket the overview shows is decided by the file's extension, so a harness
 * that named all of its fake files `.jpg` could never exercise the video, audio,
 * document, archive or APK paths — including the APK version column. The extension
 * is therefore part of the fixture, not a decoration.
 */
function mediaFiles(parent: string, prefix: string, count: number, min: number, max: number, ext = "jpg"): FileNode[] {
  const out: FileNode[] = [];
  for (let i = 0; i < count; i++) {
    const size = Math.round(min + rnd() * (max - min));
    const name = `${prefix}_${String(i).padStart(4, "0")}.${ext}`;
    out.push(file(name, `${parent}/${name}`, size));
  }
  return out.sort((a, b) => b.size - a.size);
}

function buildTree(): FileNode {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;

  const camera = dir("Camera", "/sdcard/DCIM/Camera", [
    ...mediaFiles("/sdcard/DCIM/Camera", "VID", 40, 80 * MB, 1.4 * GB, "mp4"),
    ...mediaFiles("/sdcard/DCIM/Camera", "IMG", 900, 1.5 * MB, 9 * MB),
  ]);
  const screenshots = dir("Screenshots", "/sdcard/DCIM/Screenshots", mediaFiles("/sdcard/DCIM/Screenshots", "SCR", 120, 0.4 * MB, 2 * MB));
  const dcim = dir("DCIM", "/sdcard/DCIM", [camera, screenshots]);

  const whatsapp = dir("WhatsApp", "/sdcard/Android/media/com.whatsapp/WhatsApp", [
    dir("Media", "/sdcard/Android/media/com.whatsapp/WhatsApp/Media", [
      dir("WhatsApp Videos", "/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Videos", mediaFiles("/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Videos", "WV", 60, 5 * MB, 200 * MB, "mp4")),
      dir("WhatsApp Images", "/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images", mediaFiles("/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images", "WI", 400, 0.2 * MB, 4 * MB)),
    ]),
  ]);

  const games = dir("Tencent", "/sdcard/Tencent", [
    dir("MicroMsg", "/sdcard/Tencent/MicroMsg", [
      dir("weiXin", "/sdcard/Tencent/MicroMsg/weiXin", [
        dir("attachment", "/sdcard/Tencent/MicroMsg/weiXin/attachment", mediaFiles("/sdcard/Tencent/MicroMsg/weiXin/attachment", "WX", 300, 0.5 * MB, 60 * MB)),
      ]),
    ]),
  ]);

  const android = dir("Android", "/sdcard/Android", [
    dir("data", "/sdcard/Android/data", [
      dir("com.tencent.mm", "/sdcard/Android/data/com.tencent.mm", [
        dir("cache", "/sdcard/Android/data/com.tencent.mm/cache", mediaFiles("/sdcard/Android/data/com.tencent.mm/cache", "MMC", 220, 0.1 * MB, 30 * MB)),
      ]),
      dir("com.bilibili.app.blue", "/sdcard/Android/data/com.bilibili.app.blue", [
        dir("files", "/sdcard/Android/data/com.bilibili.app.blue/files", mediaFiles("/sdcard/Android/data/com.bilibili.app.blue/files", "BL", 180, 2 * MB, 120 * MB)),
      ]),
    ]),
    dir("obb", "/sdcard/Android/obb", [
      dir("com.miHoYo.hkrpg", "/sdcard/Android/obb/com.miHoYo.hkrpg", mediaFiles("/sdcard/Android/obb/com.miHoYo.hkrpg", "OBB", 8, 200 * MB, 1.1 * GB)),
    ]),
  ]);

  const music = dir("Music", "/sdcard/Music", mediaFiles("/sdcard/Music", "MUS", 150, 3 * MB, 15 * MB, "mp3"));
  const movies = dir("Movies", "/sdcard/Movies", mediaFiles("/sdcard/Movies", "MOV", 25, 200 * MB, 2.2 * GB, "mp4"));
  const download = dir("Download", "/sdcard/Download", [
    ...mediaFiles("/sdcard/Download", "APK", 30, 20 * MB, 300 * MB, "apk"),
    ...mediaFiles("/sdcard/Download", "PDF", 45, 0.2 * MB, 12 * MB, "pdf"),
    ...mediaFiles("/sdcard/Download", "BACKUP", 4, 200 * MB, 2 * GB, "zip"),
  ]);
  const documents = dir("Documents", "/sdcard/Documents", mediaFiles("/sdcard/Documents", "DOC", 60, 0.05 * MB, 6 * MB, "docx"));

  return dir("sdcard", "/sdcard", [dcim, android, whatsapp, games, movies, download, music, documents]);
}

function summarize(tree: FileNode): { files: number; dirs: number } {
  let files = 0;
  let dirs = 0;
  (function walk(n: FileNode) {
    if (n.type === "file") files++;
    else {
      dirs++;
      n.children?.forEach(walk);
    }
  })(tree);
  return { files, dirs };
}

const tree = buildTree();
const counts = summarize(tree);

export function mockScanResponse(): ScanResponse {
  return {
    status: "ok",
    scan_time_ms: 8421,
    total_files: counts.files,
    total_dirs: counts.dirs,
    total_size: tree.size,
    errors: 37,
    // A modern daemon reports these; the mock plays along so the log line has
    // something to show in the browser harness.
    traverse_ms: 7980,
    sort_ms: 120,
    serialize_ms: 260,
    send_ms: 61,
    bytes_sent: 9 * 1024 * 1024,
    tree,
  };
}

// A deterministic placeholder so the pairing UI can be laid out in the browser.
const MOCK_QR_SVG = (() => {
  const n = 29;
  let path = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const finder = (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
      if (finder || (x * 7 + y * 11 + ((x * y) % 5)) % 3 === 0) path += `M${x + 2} ${y + 2}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 4} ${n + 4}" shape-rendering="crispEdges"><rect width="${n + 4}" height="${n + 4}" fill="#ffffff"/><path d="${path}" fill="#0f0f11"/></svg>`;
})();

// Measured on the owner's Redmi K40 with `adb shell df -k /sdcard`.
export const MOCK_CAPACITY = {
  total_bytes: 236377068 * 1024,
  used_bytes: 215375304 * 1024,
  free_bytes: 20870692 * 1024,
};

// What a picked/dropped local file pretends to weigh. `?tight=1` puts the phone
// under this, so the upload pre-check prompt is testable without a device.
const MOCK_LOCAL_FILE_BYTES = 90 * 1024 * 1024;

// Pretend the PC already holds copies in both folders so the settings page has
// something to report and clearing it visibly changes the number.
const mockDirs: Record<string, { files: number; bytes: number; path: string }> = {
  cache: { files: 12, bytes: Math.round(318.4 * 1024 * 1024), path: "D:\\SocketSweepAtlas\\data\\cache" },
  download: { files: 3, bytes: Math.round(742 * 1024 * 1024), path: "C:\\Users\\you\\Downloads" },
  thumbs: { files: 0, bytes: 0, path: "D:\\SocketSweepAtlas\\data\\thumbs" },
};

/** The disk preview cache, stood in for by a map so the wiring is testable. */
const mockThumbs = new Map<string, string>();

export function mockInvoke(cmd: string, args?: Record<string, unknown>): Promise<string> {  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // `?fail=1` in the dev browser exercises the failure path (error card, retry).
  const failing = new URLSearchParams(window.location.search).get("fail");
  if (failing && cmd === (failing || "init_daemon")) {
    return wait(900).then(() => {
      throw new Error("E#adb_unauthorized");
    });
  }
  switch (cmd) {
    case "check_adb":
      return wait(400).then(() => "Android Debug Bridge version 1.0.41");
    case "init_daemon":
      return wait(1600).then(() => JSON.stringify({ daemon_pid: "18442", serial: "SAMPLE0001", ping_response: { status: "ok" } }));
    case "run_scan":
      return wait(2400).then(() => {
        // `?real=1` loads a scan captured from a real device, served by a local
        // fixture server. Used to check perf at scale.
        if (new URLSearchParams(window.location.search).has("real")) {
          return fetch("http://127.0.0.1:5051/real-scan.json").then((r) => r.text());
        }
        // `?empty=1` exercises the "nothing readable" troubleshooting screen.
        if (new URLSearchParams(window.location.search).has("empty")) {
          return JSON.stringify({
            status: "ok", scan_time_ms: 312, total_files: 0, total_dirs: 1,
            total_size: 0, errors: 4,
            tree: { name: "sdcard", path: "/sdcard", type: "directory", size: 0, children: [] },
          });
        }
        return JSON.stringify(mockScanResponse());
      });
    case "move_items": {
      const list = (args?.paths as string[]) ?? [];
      const dest = String(args?.dest ?? "/sdcard");
      return wait(600).then(() => JSON.stringify({
        moved: list.map((path) => {
          const name = path.slice(path.lastIndexOf("/") + 1);
          return { from: path, to: `${dest}/${name}`, name };
        }),
        failed: [] as string[],
      }));
    }
    case "push_file": {
      const source = String(args?.localPath ?? "file");
      const name = source.split(/[\\/]/).pop() || "file";
      return wait(900).then(() => JSON.stringify({ remote: `/sdcard/Uploads/${name}`, name, bytes: MOCK_LOCAL_FILE_BYTES }));
    }
    case "local_file_sizes": {
      const list = (args?.paths as string[]) ?? [];
      return Promise.resolve(JSON.stringify(list.map((path) => ({ path, bytes: MOCK_LOCAL_FILE_BYTES }))));
    }
    case "cancel_transfer":
      return Promise.resolve('{"status":"cancelling"}');
    case "delete_item":
      return wait(700).then(() => JSON.stringify({ status: "ok", message: `Deleted 1 items at ${args?.path ?? "?"}` }));
    case "start_qr_pairing":
      return wait(400).then(() => JSON.stringify({
        svg: MOCK_QR_SVG,
        text: "WIFI:T:ADB;S:socketsweep-000000;P:Ab3dEf678Ghi;;",
      }));
    case "cancel_qr_pairing":
      return Promise.resolve('{"status":"cancelled"}');
    case "wireless_auto_connect":
      return wait(900).then(() => JSON.stringify(
        new URLSearchParams(window.location.search).has("no-lan")
          ? { status: "needs-pairing", serial: null, pairing_endpoint: "192.168.1.23:41275" }
          : { status: "connected", serial: "192.168.1.23:5555", pairing_endpoint: null }
      ));
    case "list_devices":
      // One phone, both transports — what `list_devices` reports once they merge.
      return wait(300).then(() => JSON.stringify([
        {
          serial: "SAMPLE0001",
          model: "SAMPLE Model",
          kind: "usb",
          status: "device",
          transports: ["SAMPLE0001", "adb-SAMPLE0001-SAMPLE._adb-tls-connect._tcp"],
        },
      ]));
    case "pair_device":
      return wait(900).then(() => `Successfully paired to ${(args?.target ?? "")} [tcp]`);
    case "connect_device":
      return wait(700).then(() => `connected to ${args?.target ?? ""}`);
    case "disconnect_device":
      return wait(300).then(() => `disconnected ${args?.target ?? ""}`);
    // `?tight=1` shrinks both volumes so the out-of-space prompt is testable.
    case "get_storage_info":
      return wait(200).then(() =>
        JSON.stringify(
          new URLSearchParams(window.location.search).has("tight")
            ? {
                ...MOCK_CAPACITY,
                used_bytes: MOCK_CAPACITY.total_bytes - 64 * 1024 * 1024,
                free_bytes: 64 * 1024 * 1024,
              }
            : MOCK_CAPACITY
        )
      );
    case "set_paths": {
      return wait(200).then(() => {
        const cache = typeof args?.cache === "string" ? args.cache : null;
        const download = typeof args?.download === "string" ? args.download : null;
        const thumbs = typeof args?.thumbs === "string" ? args.thumbs : null;
        if (cache !== null) mockDirs.cache.path = cache || "D:\\SocketSweepAtlas\\data\\cache";
        if (download !== null) mockDirs.download.path = download || "C:\\Users\\you\\Downloads";
        if (thumbs !== null) mockDirs.thumbs.path = thumbs || "D:\\SocketSweepAtlas\\data\\thumbs";
        return JSON.stringify({
          cache: mockDirs.cache.path,
          download: mockDirs.download.path,
          thumb: mockDirs.thumbs.path,
          cacheCustom: Boolean(cache),
          downloadCustom: Boolean(download),
          thumbCustom: Boolean(thumbs),
          clearOnExit: Boolean(args?.clearOnExit),
        });
      });
    }
    case "dir_stats": {
      const dir = mockDirs[String(args?.kind ?? "cache")] ?? mockDirs.cache;
      return wait(200).then(() => JSON.stringify(dir));
    }
    // The downloads panel lists what this app pulled, not the folder.
    case "stat_paths": {
      const paths = (args?.paths ?? []) as string[];
      return wait(200).then(() =>
        JSON.stringify(
          paths.map((path, i) => ({
            name: path.slice(Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")) + 1),
            bytes: 1024 * 1024 * (i + 1),
            mtime: Math.floor(Date.now() / 1000) - i * 60,
            path,
          }))
        )
      );
    }
    case "thumb_get":
      return Promise.resolve(mockThumbs.get(String(args?.key ?? "")) ?? "");
    case "thumb_put":
      return Promise.resolve((mockThumbs.set(String(args?.key ?? ""), String(args?.value ?? "")), ""));
    case "trim_thumb_cache": {
      const all = Boolean(args?.all);
      const removed = all ? mockThumbs.size : 0;
      if (all) mockThumbs.clear();
      mockDirs.thumbs.files = mockThumbs.size;
      mockDirs.thumbs.bytes = all ? 0 : mockThumbs.size * 24 * 1024;
      return wait(150).then(() => JSON.stringify({ removed, freed: removed * 24 * 1024, bytes: mockDirs.thumbs.bytes }));
    }
    // `?tight=1` makes the volume look smaller than the batch to exercise the
    // out-of-space dialog.
    case "disk_free":
      return wait(200).then(() =>
        JSON.stringify({
          path: mockDirs[String(args?.kind ?? "download") as string]?.path ?? mockDirs.download.path,
          free: new URLSearchParams(window.location.search).has("tight") ? 64 * 1024 * 1024 : 40 * 1024 * 1024 * 1024,
        })
      );
    case "cached_entries":
      return wait(200).then(() => JSON.stringify([]));
    case "reveal_folder":
      return wait(200).then(() => mockDirs[String(args?.kind ?? "cache")]?.path ?? mockDirs.cache.path);
    case "trim_cache": {
      return wait(400).then(() => {
        const before = { ...mockDirs.cache };
        const limit = Number(args?.limitBytes ?? 0);
        if (args?.all || before.bytes <= limit) {
          mockDirs.cache = { ...before, files: 0, bytes: 0 };
        } else {
          mockDirs.cache = {
            ...before,
            files: Math.max(1, Math.round(before.files * limit / Math.max(1, before.bytes))),
            bytes: limit,
          };
        }
        return JSON.stringify({
          removed: before.files - mockDirs.cache.files,
          freed: before.bytes - mockDirs.cache.bytes,
          bytes: mockDirs.cache.bytes,
        });
      });
    }
    case "ping_daemon":
      return Promise.resolve(JSON.stringify({ status: "ok", message: "pong" }));
    case "stop_daemon":
      return wait(300).then(() => JSON.stringify({ status: "ok", message: "shutting down" }));
    default:
      return Promise.reject(new Error(`mock: unknown command ${cmd}`));
  }
}
