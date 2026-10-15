# SocketSweepAtlas — technical design

[English](DESIGN.md) · [中文](DESIGN.zh-CN.md) · [User-facing README](../README.md)

This document is for anyone reading or changing the code: how the three layers fit together, what the wire protocol actually is, why several "obvious" optimisations were rejected, and how each claim in the README was measured. Numbers come from a Redmi K40 (Android 13, adb shell as uid 2000) with ~258,000 files / 34,400 directories / 146 GB, over wireless adb, unless stated otherwise.

---

## 1. Shape of the thing

```
React 19 front end (WebView2 / WKWebView / WebKitGTK)
   ↕  Tauri IPC: 30 commands + progress events
Rust bridge (src-tauri/src/lib.rs, pairing.rs)
   ↕  adb child process  +  TCP 127.0.0.1:5050 via `adb forward`
C++17 daemon on the phone (engine/daemon.cpp)
   ↕  opendir / readdir / fstatat, openat for deletes
/sdcard
```

Three rules hold the design together:

- **The phone is the only source of truth.** No cached scan is ever presented as current; a scan either completes or fails visibly.
- **Nothing reaches the network except the phone.** The app binds nothing, resolves nothing, and `adb` talks to a loopback port forwarded into the device.
- **The daemon is a guest.** It is pushed to `/data/local/tmp`, holds no privilege beyond the shell, and is killed and unlinked when the session ends.

## 2. Wire protocol

Every connection is one command, and every connection authenticates first.

```
→ AUTH <64 lowercase hex>\n
→ SCAN /sdcard\n            ← gzip({"status":"ok","scan_time_ms":…,"scan_threads":4,
                                        "skipped":0,"read_only":false,"tree":{…},
                                        "traverse_ms":…,"sort_ms":…,"serialize_ms":…,
                                        "send_ms":…,"bytes_sent":…})
→ PING\n                    ← {"status":"ok","message":"pong","protocol_version":3,"uid":2000,"read_only":false}
→ DELETE <path>\n           ← {"status":"ok","message":"Deleted 3 items"}
→ SHUTDOWN\n                ← {"status":"ok","message":"shutting down"}
```

Launch line: `daemon <port> <token-file> [--read-only] [--threads 1..8]`. Bad arguments print `Usage:` and exit non-zero — the daemon never starts with a default or absent secret. `protocol_version` is checked by the bridge (`DAEMON_PROTOCOL` in `lib.rs`), and a unit test reads the number out of `engine/daemon.cpp` so the two cannot drift apart silently; a version mismatch is reported as *the phone is running a different helper than this build ships*, not as a successful connect.

Framing is deliberately strict: the reader accepts a line only when it ends at `\n`, and rejects `\r`, NUL and anything ≥ 16 KiB. That is what makes `DELETE /sdcard/a\r\n` fail closed rather than deleting `/sdcard/a`.

Every file node carries `mtime`. It exists for the APK version cache (below) and for the modified column; the fork added it, upstream does not emit it, and `tests/test_daemon.py` asserts it on both walk paths so a future merge cannot drop it quietly.

## 3. The session secret

Upstream's `515422c` made the daemon authenticate; this fork had to teach the bridge to satisfy it.

- The bridge generates 32 random bytes (`getrandom`) per session, as 64 hex characters.
- It is written to the phone through **adb's stdin** (`umask 077 && cat > /data/local/tmp/socketsweep_token`), never as a command-line argument, so it does not appear in the device's process list.
- The daemon reads one line, validates the shape, and `unlink`s the file before accepting a single connection. Startup fails if the unlink fails.
- The token lives in a process-global mutex-guarded `Option<String>`; `stop_daemon` and every failed `init_daemon` clear it and remove the device-side file. Commands issued with no session return `E#no_session` rather than going out half-formed.

Why loopback is not enough on its own: `adb forward` exposes the port to any process on the PC, and an older unauthenticated daemon would delete anything asked. So a daemon that does not report version 3 is treated as a *failed start*.

## 4. Scan root and deletion

`engine/safe_delete.h` (upstream) pins the directory a successful scan walked:

- `Root::open()` follows the root alias once (`/sdcard` is a symlink) and keeps the **fd plus dev/inode** of the real directory.
- A delete walks the target one component at a time from that fd with `O_NOFOLLOW`, comparing identity at every level, so neither a swapped parent nor a swapped leaf can be followed. Recursive deletes never descend through a child symlink.
- No scan, no delete. A failed scan clears the previous root. The root itself and anything outside it are refused.
- If the shell is uid 0 the daemon forces `read_only` — no deletes at all, and the serial walk with whole-volume inode dedup and virtual-filesystem exclusions.

Upstream also refused to cross a filesystem boundary, checking each directory against the *root's* `st_dev`. That is the rule that made the app useless on a real phone: `/sdcard/Android/data` is its own mount (`stat -c %D` returns `d2` there while `/sdcard` is `d3`), so every `Android/data/<package>` cache — most of what needs deleting — came back refused. The set of allowed devices is now whatever the scan actually enumerated: `Root` carries a `std::set<dev_t>`, both walkers insert `info.st_dev` for every directory they open, and `descend()` checks membership instead of equality. A mount that appeared after the scan, or one the scan never entered, is still refused, and the per-directory dev/inode verification is unchanged — so the guard is still anchored to a walk the user watched happen.

The other half of the fix is that a refusal has to be *readable*. The daemon answers a refused delete exactly like a successful one — a JSON object over a healthy connection — so the bridge maps the engine's message prefixes to `E#delete_*` codes (15 prefixes → 13 codes: read-only, no scan, outside the root, boundary, symlink, depth, directory changed, permission, busy, missing, not empty, is-a-directory, plus a fallback that quotes the phone's own words) and the wording lives in the dictionary. Prefixes rather than whole sentences, because after a partial recursive failure the engine appends "…; some items were removed" to the truth, and exact matching would hide which rule refused. Before this, the UI guessed "the app may still be using the file", which sent users to check permissions when the honest answer was "that folder is on another filesystem". The scan-root guard is also enforced on the PC side (`E#delete_scan_root`) so that path never leaves the machine.

The fork's addition on the bridge side is that deletes must be *addressable*: paths with newline or NUL never leave the PC at all (`E#cmd_unsafe`).

## 5. The directory walk — and why it is not upstream's

Reading a directory on this phone blocks rather than computes, and concurrent walks were measured to overlap almost perfectly, so directories go to a pool of readers: each worker reads one directory, writes its entries into that directory's own slot, and queues its subdirectories. One thread then knits the tree, folding sizes upward and sorting children in exactly the order the recursive walk did — which is what makes the answer byte-for-byte identical to the serial scan, ties included.

Upstream solved the same problem with `parallel_scan.h`, which additionally re-opens every queued directory from the pinned root, component by component, with `O_NOFOLLOW` and an identity check. Measured on the same phone, same data, three interleaved rounds with the starting order rotated each round:

| walker | phone-side traversal |
|---|---|
| serial reference | 24.0 / 9.1 / 10.0 s |
| **this fork's pool (in use)** | **4.5 / 3.4 / 3.2 s** |
| upstream's anchored walk | 18.4 / 13.4 / 13.5 s |

The trees are identical: on a quiet `/sdcard/DCIM` all three flatten to the same 3,022 lines; on the full disk only 22 lines differ, and each of those is a QQ log file whose size or mtime changed between scans. So upstream's walk is correct and about four times slower — the cost is `directories × depth` extra syscalls.

The fork keeps its own walk and keeps upstream's anchoring **on the delete path**, on the reasoning that a directory swapped mid-scan can only misreport a size, while a directory swapped mid-delete can cost data. That reasoning is written into `engine/daemon.cpp` next to the code, and `tests/test_parallel_scan.py` runs the same binary at `--threads 1` and `--threads 4` and compares the parsed trees, so a future merge cannot quietly swap the implementation back.

Default is four readers (`cfg::DEFAULT_SCAN_THREADS`), clamped to the core count, overridable with `--threads 1..8`. Four is where the measured gain flattened out.

## 6. Compression, and timing that survives it

`JsonStream` writes the answer straight into a gzip member (`deflateInit2(16+15)`, 64 KiB output buffer, flushed at 32 KiB) so a 57.5 MB answer becomes 9.3 MB on the wire. If zlib refuses to start, the stream falls back to plain text and says so on stderr — a slower scan is acceptable, a broken one is not. The bridge sniffs the two gzip magic bytes rather than assuming.

Phase timings are taken *inside* the compressor, which is the subtle part: with compression on, most of the tree is still in zlib's buffers when serialisation "finishes". `out.sync()` therefore does a `Z_SYNC_FLUSH` — pushing the buffer out and emitting what deflate is holding back, without closing the gzip member — so `send_ms` and `bytes_sent` describe the whole payload and the reader still gets one well-formed stream. `finish()` closes the member at the end, and a truncated write is logged as an incomplete answer.

Measured on the phone: traverse 2.3 s, sort 0.03 s, serialise 0.6 s, send 0.05 s, 9.3 MB on the wire. Wireless adb carries about 2.4 MB/s, USB about 38 MB/s — which is why the tunnel, not the filesystem, is now the floor.

## 7. The Rust bridge

- **Every phone-touching command is `async`**, including `ping_daemon`, which the UI polls while connecting.
- `DAEMON_OPERATION` serialises session changes (start, stop, reconnect). `run_scan` deliberately does **not** take that mutex: it can outlive a reconnect, and `std::mutex` is not reentrant — the recovery path calls `init_daemon`, which does take it.
- Answers are checked before they are believed: an empty body, a body that is not a JSON object, a failed inflate, and a JSON answer whose file count is zero while the phone reported data are each a distinct error code, and the first three trigger one automatic restart-and-rescan.
- File names must be valid UTF-8: the bridge refuses to hand the front end a lossy-decoded tree, because a mangled path is a path you cannot delete or open.
- `peek_file` reads a byte range (`offset` + `limit`, capped at 2 MB) rather than a whole file. Previews read the head; the APK reader reads the tail. The block count is clamped so the final block is never silently dropped — that bug cost the zip index's end-of-directory record, i.e. the last few hundred bytes of the file, which is exactly where it lives.
- `df` output is parsed defensively; an empty answer is `E#df_empty`, not a panic or an English sentence.

## 8. Front end

| Module | Responsibility |
|---|---|
| `App.tsx` | connect flow, scan scheduling and timing, log and error cards |
| `ResultView.tsx` | the three views (overview / folder / type), table, selection, share tint, space dialogs, scroll memory |
| `opener.ts` | open/download/upload/move/delete, queues, cancellation, space preflight, cache ledger |
| `thumbs.ts`, `Thumb.tsx` | EXIF thumbnail mining, data URI, lazy mounting and concurrency cap |
| `apkFormat.ts`, `apkInfo.ts`, `ApkVersion.tsx` | zip index and binary-XML parsing, byte-range reads and disk cache, lazy cell |
| `i18n.ts`, `messages.ts` | language context and every string, including backend codes |
| `settings.ts` | persisted settings, defaults, colour validation |
| `mockScan.ts` | browser-only fake back end for the harness (`isMockMode`) |

Two things worth knowing before changing it:

- **Rows are mounted progressively.** `shown` grows to fill the viewport and `useLayoutEffect` restores both the scroll offset and the row count when you walk into a folder and back, so a 250,000-node tree never becomes 250,000 DOM nodes.
- **The type buckets come from extensions, in one place.** The mock harness now names its fake files accordingly (`.mp4`, `.mp3`, `.apk`, `.pdf`, `.zip`), because a fixture where everything is `.jpg` cannot exercise the video, audio, document, archive or APK paths at all.

### APK versions

`versionName` is not in the file name and not in the listing: it lives in `AndroidManifest.xml`, which inside an APK is a *binary* XML chunk addressed from the zip index at the **end** of the file. So the reader looks one name up in the central directory (window doubling from 256 KiB to 2 MiB, starting on a block boundary so the tail is never truncated), reads the local header to find the payload, inflates raw DEFLATE in the browser via `DecompressionStream("deflate-raw")`, and walks the string pool and the root element's attribute table. Both `versionName` (type `0x03`) and `versionCode` (type `0x10`) are read, and the human-facing one wins.

Nothing is guessed: any shape that is not exactly what the format specifies returns null and the cell stays empty, because a plausible-but-wrong version is worse than none. Answers are cached on disk under `apk-<fnv1a(path)>-<size>-<mtime>`; only *positive* answers are stored, so an APK that could not be read today is retried tomorrow rather than frozen as blank.

### Error codes and language

The backend never sends prose the user reads: it emits `E#code` or `E#code#detail`, and `messages.ts` holds the wording in both languages. Log entries store *key plus parameters*, so switching language re-words the entries already on screen. The audit that keeps this honest must match bare string literals as well as `format!` calls — checking only the former once produced a confident "zero untranslated strings" that was simply wrong.

## 9. Disk caches

Three folders, three lifetimes, all configurable and defaulting to `data/` next to the installed app rather than the system drive:

- **cache** — copies of files you opened on the PC. Size-capped, oldest-first eviction, optionally cleared on exit.
- **thumbs** — extracted image previews and APK versions. Independent cap and independent clear button.
- **downloads** — only files you explicitly downloaded. Never auto-cleaned, never counted as cache.

Keys are hashes of the device path with size and `mtime` in the name, so a file that changed on the phone can never be served from a stale entry.

## 10. Performance history

| stage | whole scan (warm) | phone-side traversal | wire bytes |
|---|---|---|---|
| as inherited from upstream | ~74 s | ~33 s | 57.0 MB |
| + gzip answer, single walk | 21–35 s | 24.6 s | **9.2 MB** |
| + parallel walk (fork) | **6–10 s** | **2.4–4.5 s** | 9.2 MB |

Daemon memory peaks at 97.5 MB with four readers against 79.0 MB serial, and the binary is 797 KB stripped. "Memory is flat" is only true of the 64 KiB serialisation buffer: **the whole tree is built in phone RAM before the first byte is sent**, which is also why no partial results can appear mid-scan. Streaming would fix both, and needs the scan to be re-planned first (upstream issue #9).

Measurement discipline, because it has been learned the hard way: the phone's own metadata cache makes a cold scan three to five times slower than a warm one, so **every A/B here is interleaved and repeated with the starting order rotated**, and comparisons are made on flattened trees (depth, type, size, mtime, full path) rather than on totals. A first attempt at the parallel-walk benchmark once reported "74 s for one thread" because the shell had forked 4,096 `find` processes; a stale installer that was not re-copied from the build directory once "proved" a fix that had never been installed.

## 11. Tests

| command | covers | runs on |
|---|---|---|
| `npm test` | `formatBytes` incl. signed, fractional, non-finite and every finite power of two | anywhere |
| `cargo test --lib` | `AUTH` framing, what a command may not contain, secret shape, and that `DAEMON_PROTOCOL` equals the number `engine/daemon.cpp` announces | Linux/macOS/Windows-MSVC (a GNU-toolchain test exe has no manifest, so comctl32 v6 entrypoints are missing at load) |
| `python3 -m unittest discover -s tests` | the daemon compiled from source: auth, invalid frames, scan-root rules, delete races, read-only mode, hard-link dedup, mtime, one-vs-four equivalence | Linux/macOS only (`openat`, `/dev/fd`, symlinks, `RLIMIT_NOFILE`) |
| `python3 -m unittest … test_root_scan.py` (sudo) | a UID-0 daemon in a throwaway chroot: exclusions, aliases, rescan dedup reset, delete refusal as root | Linux |

Plus two things that live outside the repository because they need the phone: an on-device three-way walk comparison producing flattened trees for md5, and a recovery test that kills the daemon until `pidof` is empty and then asks the UI to rescan.

## 12. Build and packaging

- `engine/build.sh` cross-compiles for `aarch64-linux-android31` with `-static-libstdc++ -s` and links the NDK sysroot's `libz.a` (falling back to `-lz`), then copies the result to `src-tauri/bin/daemon` — the bundler only ever ships that second copy, and forgetting the copy is a real and repeated way to release the old daemon.
- CI builds Linux (ubuntu-22.04, for a low glibc floor), macOS and Windows, runs all three test layers, and publishes draft releases on tags. The AppImage leg fixes `.DirIcon`, normalises directory modes that `tauri-bundler` leaves at 0700, and embeds `gh-releases-zsync` update information derived from `GITHUB_REPOSITORY` so a fork does not update from upstream's releases.
- Windows: NSIS only. Which `WebView2Loader` you ship depends on the toolchain, and this was gotten wrong once inside this fork: `webview2-com-sys` 0.38.2 picks `link(name = "WebView2LoaderStatic", kind = "static")` under `target_env = "msvc"` and `link(name = "WebView2Loader.dll")` otherwise. So CI's MSVC build needs nothing next to the exe, while our GNU build's import table (verified with `objdump -p`) names the DLL and the installer must carry it — hence the gitignored `src-tauri/webview2/WebView2Loader.dll` and its entry in the overlay. The lesson is that the import table of one build is not evidence about another toolchain. The bundler also enforces that npm and crate versions of every Tauri plugin agree on minor version — hence the exact pin on `@tauri-apps/plugin-opener`.
- The version number is carried in `package.json` and `tauri.conf.json`; a tag push overwrites both inside CI.

## 13. Known limits and what was deliberately not done

- **No partial results during a scan**, and no "show the last scan while refreshing": the numbers on screen must describe the phone as it is now.
- **No incremental/cached scan by directory mtime.** With traversal at ~3 s the ceiling is no longer worth a risk of showing stale sizes.
- **No streaming scan protocol and no scan store.** Upstream shipped both after this fork's merge point; adopting them means re-planning the answer format and the tree-building step together, and the fork's measurement says the tunnel, not the walk, is the current floor.
- **No custom scan folder** — you cannot know which subtrees are worth scanning until you have scanned everything.
- **No binary protocol.** The path-bytes reduction (send file names only, rebuild paths on the PC) is the next real win for wireless, and it can be done inside JSON.
- The APK version column covers the one file type where the declared version is worth a read; video and audio durations were considered and dropped, because a duration needs a per-format parser and the row height does not pay for it.

## 14. Upstream

Merged from upstream: `515422c` (authenticated sessions), `f2248cd` (anchored deletion), `8b177e5` (read-only root scanning), `ff8b789` (bounded parallel walk, exclusions, `skipped`/`scan_threads`/`read_only` fields), `054b7ca` (`formatBytes`), `ed22f3e` (AppImage delta updates), plus the CI workflow they landed in.

`f2248cd` is the one merged change this fork had to widen afterwards: its filesystem-boundary check compared each directory against the *root's* device, and on Android that refuses every `Android/data` folder. The rule, the replacement and why the guard is still anchored are in section 4.

Not merged, with reasons: `parallel_scan.h`'s walk (four times slower here, section 5), `06ed780` (removes the opener plugin — this fork's *reveal in folder* needs it, and the compiler says so the moment it goes), the streaming scan and scan store (section 13), and the front-end UI tests (they assert an interface this fork replaced).

Where the fork's version of a shared file had to survive a merge — the gzip stream, `mtime`, the phase timings, the walk — the graft is commented in place, because the next merge is a matter of when, not if.
