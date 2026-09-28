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

function mediaFiles(prefix: string, count: number, min: number, max: number): FileNode[] {
  const out: FileNode[] = [];
  for (let i = 0; i < count; i++) {
    const size = Math.round(min + rnd() * (max - min));
    out.push(file(`${prefix}_${String(i).padStart(4, "0")}.jpg`, `/mock/${prefix}_${i}.jpg`, size));
  }
  return out.sort((a, b) => b.size - a.size);
}

function buildTree(): FileNode {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;

  const camera = dir("Camera", "/sdcard/DCIM/Camera", [
    ...mediaFiles("VID", 40, 80 * MB, 1.4 * GB),
    ...mediaFiles("IMG", 900, 1.5 * MB, 9 * MB),
  ]);
  const screenshots = dir("Screenshots", "/sdcard/DCIM/Screenshots", mediaFiles("SCR", 120, 0.4 * MB, 2 * MB));
  const dcim = dir("DCIM", "/sdcard/DCIM", [camera, screenshots]);

  const whatsapp = dir("WhatsApp", "/sdcard/Android/media/com.whatsapp/WhatsApp", [
    dir("Media", "/sdcard/Android/media/com.whatsapp/WhatsApp/Media", [
      dir("WhatsApp Videos", "/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Videos", mediaFiles("WV", 60, 5 * MB, 200 * MB)),
      dir("WhatsApp Images", "/sdcard/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images", mediaFiles("WI", 400, 0.2 * MB, 4 * MB)),
    ]),
  ]);

  const games = dir("Tencent", "/sdcard/Tencent", [
    dir("MicroMsg", "/sdcard/Tencent/MicroMsg", [
      dir("weiXin", "/sdcard/Tencent/MicroMsg/weiXin", [
        dir("attachment", "/sdcard/Tencent/MicroMsg/weiXin/attachment", mediaFiles("WX", 300, 0.5 * MB, 60 * MB)),
      ]),
    ]),
  ]);

  const android = dir("Android", "/sdcard/Android", [
    dir("data", "/sdcard/Android/data", [
      dir("com.tencent.mm", "/sdcard/Android/data/com.tencent.mm", [
        dir("cache", "/sdcard/Android/data/com.tencent.mm/cache", mediaFiles("MMC", 220, 0.1 * MB, 30 * MB)),
      ]),
      dir("com.bilibili.app.blue", "/sdcard/Android/data/com.bilibili.app.blue", [
        dir("files", "/sdcard/Android/data/com.bilibili.app.blue/files", mediaFiles("BL", 180, 2 * MB, 120 * MB)),
      ]),
    ]),
    dir("obb", "/sdcard/Android/obb", [
      dir("com.miHoYo.hkrpg", "/sdcard/Android/obb/com.miHoYo.hkrpg", mediaFiles("OBB", 8, 200 * MB, 1.1 * GB)),
    ]),
  ]);

  const music = dir("Music", "/sdcard/Music", mediaFiles("MUS", 150, 3 * MB, 15 * MB));
  const movies = dir("Movies", "/sdcard/Movies", mediaFiles("MOV", 25, 200 * MB, 2.2 * GB));
  const download = dir("Download", "/sdcard/Download", [
    ...mediaFiles("APK", 30, 20 * MB, 300 * MB),
    ...mediaFiles("PDF", 45, 0.2 * MB, 12 * MB),
  ]);
  const documents = dir("Documents", "/sdcard/Documents", mediaFiles("DOC", 60, 0.05 * MB, 6 * MB));

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

export function mockInvoke(cmd: string, args?: Record<string, unknown>): Promise<string> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // `?fail=1` in the dev browser exercises the failure path (error card, retry).
  const failing = new URLSearchParams(window.location.search).get("fail");
  if (failing && cmd === (failing || "init_daemon")) {
    return wait(900).then(() => {
      throw new Error("USB Debugging not authorised. Check the confirmation dialog on your phone.");
    });
  }
  switch (cmd) {
    case "check_adb":
      return wait(400).then(() => "Android Debug Bridge version 1.0.41");
    case "init_daemon":
      return wait(1600).then(() => JSON.stringify({ daemon_pid: "18442", serial: "982b7b0a", ping_response: { status: "ok" } }));
    case "run_scan":
      return wait(2400).then(() => {
        // `?real=1` loads a scan captured from a real device, served by
        // `node fixture-server.mjs` (see F:\dev). Used to check perf at scale.
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
    case "delete_item": {
      return wait(700).then(() => JSON.stringify({ status: "ok", message: `Deleted 1 items at ${args?.path ?? "?"}` }));
    }
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
      return wait(300).then(() => JSON.stringify([
        { serial: "982b7b0a", model: "M2012K11AC", kind: "usb", status: "device" },
        { serial: "192.168.1.23:5555", model: "M2012K11AC", kind: "wireless", status: "device" },
      ]));
    case "pair_device":
      return wait(900).then(() => `Successfully paired to ${(args?.target ?? "")} [tcp]`);
    case "connect_device":
      return wait(700).then(() => `connected to ${args?.target ?? ""}`);
    case "disconnect_device":
      return wait(300).then(() => `disconnected ${args?.target ?? ""}`);
    case "get_storage_info":
      return wait(200).then(() => JSON.stringify(MOCK_CAPACITY));
    case "ping_daemon":
      return Promise.resolve(JSON.stringify({ status: "ok", message: "pong" }));
    case "stop_daemon":
      return wait(300).then(() => JSON.stringify({ status: "ok", message: "shutting down" }));
    default:
      return Promise.reject(new Error(`mock: unknown command ${cmd}`));
  }
}
