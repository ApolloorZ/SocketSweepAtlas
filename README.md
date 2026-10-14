# SocketSweepAtlas

**See exactly what is eating your phone's storage — in seconds, over USB or Wi-Fi, with nothing installed on the phone.**

[中文说明](README.zh-CN.md) · [Technical design](docs/DESIGN.md) · [Design 文档](docs/DESIGN.zh-CN.md)

SocketSweepAtlas is a maintained fork of [SocketSweep](https://github.com/VishnuSrivatsava/SocketSweep) by [Vishnu Srivatsava](https://github.com/VishnuSrivatsava), released under the same **GPL-3.0** licence — see [LICENSE](LICENSE). It started from upstream `main` at `bedcb60` and has upstream's later security work merged in. [What this fork changed](#what-this-fork-changed) is listed below; the source of every claim is in the design document.

---

## Why this exists

Plug a phone into a PC and open it in File Explorer. Click a folder with a lot in it. **"Calculating size…"** — four minutes later you have half an answer, and MTP has to be re-asked for every single file, forever.

SocketSweepAtlas skips MTP. It talks to the phone through `adb`, walks the filesystem directly with four reader threads, compresses the answer on the phone, and builds the whole tree on your PC. No app on the phone. No root. Nothing is uploaded anywhere — the program never opens a network socket except to the phone.

```
Full scan of a Redmi K40, 258,000 files, 146 GB, over wireless adb:

  original SocketSweep ............... ~74 s
  + gzip the answer .................. 21–35 s
  + parallel directory walk .......... 6–10 s      ← this fork
```

## What you see

**Two ways in, and the phone remembers both.** Cable, or wireless pairing by QR code — after the first pairing, one click connects and starts scanning.

![Connect screen](assets/fork/01-connect.png)

**The overview answers the first question you have.** One treemap of the top-level folders, and every file type counted in the same pass — no second scan to find out how much your videos weigh.

![Overview](assets/fork/02-overview.png)

**Then it becomes a file manager.** Sortable columns (size, share of the disk, name, modified date, and the folder a file sits in), search inside the current folder, select-all, drag-to-paint multi-selection that scrolls when you reach the edge, and a whole-row tint that shows how much of the disk each entry takes.

![File list](assets/fork/03-files-table.png)

**Navigate by folder, and come back where you left off.** Breadcrumbs, a back arrow that behaves at the root, and the scroll position of every folder is remembered while you explore.

![Folder view](assets/fork/04-folder.png)

**Type views, including the version an APK declares.** The APK view reads each package's own manifest and shows its `versionName` — no install, no unpacking, nothing written to the phone.

![Type view](assets/fork/05-category.png)

**Your machine, your rules.** Dark or light, Chinese or English (including every error message coming back from the phone), and the preview and opened-file caches live in folders next to the app instead of filling up your C: drive.

![Settings](assets/fork/07-settings.png)

## What this fork changed

Everything below is measured on a Redmi K40 with ~258,000 files over wireless adb; the numbers and the method are in [docs/DESIGN.md](docs/DESIGN.md).

- **Roughly ten times faster on the phone, three times faster on the wire.** The phone gzips its own answer (57.5 MB of repeated paths becomes 9.3 MB) and walks directories with a small pool of readers, because `readdir` and `lstat` block rather than compute: the phone's own traversal went from ~24 s to 2.4–4.5 s.
- **The parallel walk is the fork's own, deliberately.** Upstream also added a parallel walker, which re-opens every queued directory from the pinned scan root — a stronger guarantee during a scan, but about four times slower here (13–18 s against 3–5 s, three interleaved rounds, same phone, same data) while producing a byte-identical tree. The anchor-and-verify protection is kept where it can actually cost data: the delete path.
- **The whole interface is Chinese or English**, switchable in Settings and remembered on the machine — *including every backend failure*, which travels to the front end as an error code and is worded there, so nobody sees a raw system message in the wrong language.
- **A file list built for daily use**: every column header sorts, the folder a file lives in is clickable, previews are dug out of each photo's own EXIF thumbnail, APK version numbers are read out of the package, selection is visible as a whole-row fill, and each folder remembers where you had scrolled.
- **Both directions.** Upload by button or by dragging files in, move files inside the phone, and stop a running transfer — a stopped transfer leaves no half-written file on either side. Free space is checked on the PC *and* on the phone before any byte moves.
- **Wireless first.** QR pairing, a three-step fallback when the LAN search finds nothing, and one row per phone even when it is plugged in *and* paired over Wi-Fi.
- **Failures are visible and mostly self-healing.** A tunnel that drops mid-scan, an answer that arrives with nothing in it, and a daemon that starts but reads zero files are each detected, reported, and recovered by restarting the phone-side helper and rescanning once. Commands that talk to the phone run off the UI thread, and no console window flashes per `adb` call.
- **Deletion that works on a real Android layout — and explains itself when it refuses.** `/sdcard/Android/data` is its own filesystem on Android, so upstream's "never cross a filesystem boundary" rule refused every app cache folder, which is most of what is worth deleting. A delete now follows the scan across the mounts that scan actually walked, and still refuses one it never entered. A refusal reports the phone's own rule — already gone, held open, outside the folder you scanned, another filesystem, a symlink, nested too deep — instead of one generic guess about permissions.
- **Scratch lives where you put the app.** Previews and opened-file caches default to folders under the installation directory, are sized, listed and cleared separately, and downloads are never auto-cleaned.
- **The log panel prints the phone's own phase breakdown** — traverse, sort, write, send, compressed size — so a slow scan says where the time actually went.

**Safety, which was the point of merging upstream's work:**

- Scanning is read-only. Deleting, moving and uploading always ask first, and the folder you scanned is pinned: anything outside it cannot be deleted, and the scan root itself never can.
- Every connection to the phone carries a random one-shot session secret. A command that arrives without it — or with the wrong one — is refused before it is parsed, and the secret file on the phone is `0600` and unlinked the moment the helper starts.
- Deletes are resolved one `openat` component at a time from the pinned directory, with `O_NOFOLLOW` and an identity check at each level, so a path swapped mid-operation cannot be followed.
- If the phone's shell happens to run as root, the helper forces itself read-only and refuses every delete.

## Getting started

**Requirements:** a PC, a USB cable or the same Wi-Fi, and [Android platform-tools](https://developer.android.com/tools/releases/platform-tools) (`adb` ships inside this app on Windows; on Linux/macOS install it or let the app find it). Android 11+ works; the phone needs USB debugging, and wireless needs *Wireless debugging* → *Pair device with QR code* once.

1. Download `SocketSweepAtlas_1.3.0_*` from [Releases](releases/latest) — Windows `.exe` (NSIS), Linux `.deb` / `.AppImage`, macOS `.dmg`.
2. Enable USB debugging on the phone (Settings → About phone → tap *Build number* seven times → Developer options).
3. Plug in, allow the RSA prompt, and press **Scan**. Or use **Wireless** and scan the pairing QR code once — after that it reconnects by itself.

Samsung devices: the phone drops adb when the screen locks, so keep it awake. MIUI/HyperOS: keep the *Wireless debugging* page open during the first pairing — some builds only broadcast while that screen is visible.

## Building from source

```bash
npm ci
npm test                                          # front-end helpers
NDK=/path/to/android-ndk bash engine/build.sh     # the phone-side helper (aarch64, static zlib)
npm run tauri dev                                 # run against a real phone
npm run tauri build                               # package
```

Three fork-specific notes: `engine/build.sh` and both CI daemon steps link zlib (the helper compresses its own answer); the Windows binaries `adb.exe`, `AdbWinApi.dll`, `AdbWinUsbApi.dll` and `WebView2Loader.dll` are gitignored and must be dropped in by hand; and Windows builds with the GNU toolchain need `--config src-tauri/tauri.windows-gnu.json` plus `crate-type = ["rlib"]` in `src-tauri/Cargo.toml`. On Windows/GNU, `cargo test --lib` and the Python daemon suite cannot execute locally — CI runs them.

The tests worth knowing about: `npm test` for byte formatting, `cargo test --lib` for the command framing and the protocol-version agreement between Rust and C++, and `python3 -m unittest discover -s tests` for the daemon itself (auth, scan-root protection, delete races, one-reader-versus-four equivalence — Linux/macOS only).

## Troubleshooting

| Symptom | What is actually happening |
|---|---|
| **0 files, or missing folders on Android 11+** | The app reads `/sdcard` through adb, which is not the same view as the MediaStore. Re-scan; if a folder is genuinely protected by scoped storage it will not appear. |
| **"Scanning never starts" on Samsung** | The phone kills adb when the screen locks or when *Disable USB activities* is on. Keep the screen awake and turn that developer option off. |
| **Wireless pairing times out** | The phone must be on the same Wi-Fi, and the *Wireless debugging* dialog must stay open while pairing. |
| **A scan takes far longer than the numbers above** | Look at the log panel's phase line. If *send* dominates, the tunnel is the limit (wireless adb runs about 2.4 MB/s here); if *traverse* dominates, the phone is cold or busy writing. |

## Third-party components

An installed copy carries more than this repository's source, and each piece keeps its own terms:

| Component | Licence | Where it ends up |
|---|---|---|
| adb (Android platform-tools, Google) | Apache-2.0 | next to the app; used to reach the phone |
| `WebView2Loader.dll` (Microsoft) | Microsoft WebView2 distribution terms | next to the executable in Windows builds |
| zlib, **statically linked into the phone helper** | zlib licence (GPL-compatible) | inside `src-tauri/bin/daemon` |
| Inter, JetBrains Mono | SIL Open Font License 1.1 | embedded in the front end and served from the app rather than a CDN; licence texts are in [`licenses/`](licenses) |
| Tauri 2, React 19, Recharts | MIT / Apache-2.0 | the desktop shell and the UI |

## Credits and licence

The original SocketSweep — its name, its idea, and the phone-side approach — is [Vishnu Srivatsava](https://github.com/VishnuSrivatsava)'s work, and he has been publicly supportive of forks and pull requests. The architecture was inspired by [scrcpy](https://github.com/Genymobile/scrcpy).

This fork is distributed under the **GNU General Public License v3.0** like the original: see [LICENSE](LICENSE). The complete corresponding source for any build of this fork is this repository at the commit that build came from, and the commit history is the record of what was modified.
