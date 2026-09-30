// ============================================================================
// lib.rs — SocketSweep Tauri Bridge (Phase 2)
// ============================================================================
// Orchestrates the C++ Android daemon via ADB and communicates with it
// over a TCP tunnel.  All commands return Result<String, String> so the
// React frontend can display meaningful error messages.
//
// Wire protocol (matches Phase 1 daemon):
//   → "PING\n"              ← {"status":"ok","message":"pong"}
//   → "SCAN [path]\n"       ← {"status":"ok","scan_time_ms":…,"tree":{…}}
//   → "SHUTDOWN\n"          ← {"status":"ok","message":"shutting down"}
// ============================================================================

mod pairing;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

// ── Constants ───────────────────────────────────────────────────────────────

const DAEMON_PORT: u16 = 5050;
const DAEMON_ADDR: &str = "127.0.0.1:5050";
const DEVICE_BIN_PATH: &str = "/data/local/tmp/socketsweep_daemon";
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TCP_READ_TIMEOUT: Duration = Duration::from_secs(120); // scans can be slow

/// Tracks the root path of the last successful scan so we can prevent its deletion.
static SCAN_ROOT: Mutex<Option<String>> = Mutex::new(None);

/// Tracks the serial of the connected device so all ADB calls target the right device.
static DEVICE_SERIAL: Mutex<Option<String>> = Mutex::new(None);

// ── Messages the front end words ────────────────────────────────────────────
// Anything the user is meant to read travels as `E#code` or `E#code#argument`.
// The wording itself lives in src/messages.ts in both languages, so the text can
// follow the language the user picked instead of being frozen here.

pub(crate) fn err(code: &str) -> String {
    format!("E#{code}")
}

pub(crate) fn err_arg(code: &str, arg: impl std::fmt::Display) -> String {
    format!("E#{code}#{arg}")
}

// ── Resource Resolution ─────────────────────────────────────────────────────

use tauri::Manager;

pub(crate) fn get_bundled_binary(app: &tauri::AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| format!("Failed to get resource dir: {}", e))?;

    // On Windows, host-native binaries like ADB use a .exe extension.
    // Try the .exe variant first, then fall back to the extensionless name
    // (needed for cross-platform binaries like the Android daemon).
    #[cfg(target_os = "windows")]
    {
        let exe_path = resource_dir.join("bin").join(format!("{name}.exe"));
        if exe_path.exists() {
            return Ok(exe_path);
        }
    }

    let path = resource_dir.join("bin").join(name);
    if path.exists() {
        Ok(path)
    } else {
        Err(format!("Bundled binary '{}' not found at {:?}", name, path))
    }
}

// ── ADB helper ──────────────────────────────────────────────────────────────

/// A GUI app has no console, so every child it spawns gets one of its own —
/// which meant a black box flashing once per adb call.
fn hide_console(mut cmd: Command) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// Run an ADB command and return its stdout. Maps any failure to a
/// human-readable `Err(String)`.
pub(crate) fn adb(adb_path: &std::path::Path, args: &[&str]) -> Result<String, String> {
    use std::io::Read;
    use std::time::{Duration, Instant};

    let mut child = hide_console(Command::new(adb_path))
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to execute adb binary at {:?}: {}", adb_path, e))?;

    let mut stdout_pipe = child.stdout.take().unwrap();
    let mut stderr_pipe = child.stderr.take().unwrap();

    let stdout_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });

    let stderr_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });

    let timeout_secs = 15;
    let timeout = Duration::from_secs(timeout_secs);
    let start = Instant::now();
    let status;

    loop {
        if let Some(s) = child.try_wait().map_err(|e| format!("Failed to wait on adb process: {}", e))? {
            status = s;
            break;
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("ADB command timed out after {} seconds. Please reconnect your device and try again.", timeout_secs));
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    let stdout_bytes = stdout_thread.join().unwrap_or_default();
    let stderr_bytes = stderr_thread.join().unwrap_or_default();

    let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();

    if !status.success() {
        let combined = format!("{stdout} {stderr}").to_lowercase();
        if combined.contains("no devices") || combined.contains("device not found") {
            return Err("No Android device detected. Connect your phone via USB and enable USB Debugging.".into());
        }
        if combined.contains("unauthorized") {
            return Err("USB Debugging not authorised. Check the confirmation dialog on your phone.".into());
        }
        return Err(format!(
            "adb {} failed (exit {}):\n{stderr}",
            args.join(" "),
            status.code().unwrap_or(-1)
        ));
    }

    Ok(stdout)
}

/// Run an ADB command targeting the stored device serial (if any).
/// Prepends `-s <serial>` when a device serial is known.
/// The transport the current session is talking to, when one was chosen.
fn device_serial() -> Option<String> {
    DEVICE_SERIAL.lock().ok().and_then(|guard| guard.clone())
}

fn adb_s(adb_path: &std::path::Path, args: &[&str]) -> Result<String, String> {
    if let Some(serial) = device_serial() {
        let mut full_args = vec!["-s", serial.as_str()];
        full_args.extend_from_slice(args);
        return adb(adb_path, &full_args);
    }
    adb(adb_path, args)
}

// ── TCP helper ──────────────────────────────────────────────────────────────

/// Send a one-line command to the daemon and read the full response.
/// Where the time actually goes on a scan. Only printed for large replies, so
/// the PING and DELETE traffic stays quiet in the dev log.
fn note_stage(wire: usize, plain: usize, connect: f64, send: f64, read: f64, unzip: f64, to_string: f64) {
    if wire < 1024 * 1024 {
        return;
    }
    println!(
        "[TIMING] rust: 连接 {connect:.1}ms 发送 {send:.1}ms 读取 {read:.1}ms 解压 {unzip:.1}ms 转字符串 {to_string:.1}ms · 线上 {:.1} MB → 展开 {:.1} MB",
        wire as f64 / 1048576.0,
        plain as f64 / 1048576.0
    );
}

fn daemon_command(cmd: &str) -> Result<String, String> {
    let started = std::time::Instant::now();
    let mut stream = TcpStream::connect_timeout(
        &DAEMON_ADDR.parse().unwrap(),
        TCP_CONNECT_TIMEOUT,
    )
    .map_err(|e| format!("Cannot connect to daemon at {DAEMON_ADDR}: {e}"))?;
    let connected = started.elapsed();

    stream
        .set_read_timeout(Some(TCP_READ_TIMEOUT))
        .map_err(|e| format!("Failed to set read timeout: {e}"))?;

    let payload = if cmd.ends_with('\n') {
        cmd.to_string()
    } else {
        format!("{cmd}\n")
    };
    stream
        .write_all(payload.as_bytes())
        .map_err(|e| format!("Failed to send command to daemon: {e}"))?;
    let sent = started.elapsed();

    let mut response_bytes = Vec::with_capacity(1024 * 1024);
    stream
        .read_to_end(&mut response_bytes)
        .map_err(|e| format!("Failed to read daemon response: {e}"))?;
    let read = started.elapsed();

    // The scan answer arrives gzipped: the phone produces it far faster than the
    // wireless adb tunnel can carry it. PING and DELETE are still plain text, so
    // the two magic bytes decide rather than a flag that could lie.
    let wire = response_bytes.len();
    let plain = if response_bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::with_capacity(wire * 6);
        std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&response_bytes[..]), &mut out)
            .map_err(|e| err_arg("inflate_failed", e))?;
        out
    } else {
        response_bytes
    };
    let unzipped = started.elapsed();

    let response = String::from_utf8_lossy(&plain).trim().to_string();
    let decoded = started.elapsed();

    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    note_stage(
        wire,
        plain.len(),
        ms(connected),
        ms(sent - connected),
        ms(read - sent),
        ms(unzipped - read),
        ms(decoded - unzipped),
    );
    Ok(response)
}

// ── Tauri Commands ──────────────────────────────────────────────────────────

#[tauri::command(async)]
fn check_adb(app: tauri::AppHandle) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let version = adb(&adb_path, &["version"])?;
    let first_line = version.lines().next().unwrap_or("unknown").to_string();
    Ok(first_line)
}

#[tauri::command(async)]
fn init_daemon(app: tauri::AppHandle, serial: Option<String>) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let daemon_src = get_bundled_binary(&app, "daemon")?;

    // 1 — Verify ADB is reachable and a device is connected.
    adb(&adb_path, &["version"])?;
    let devices = adb(&adb_path, &["devices"])?;
    let available: Vec<(String, String)> = devices
        .lines()
        .skip(1)
        .filter_map(|line| {
            let mut cols = line.split_whitespace();
            let serial = cols.next()?.to_string();
            let status = cols.next()?.to_string();
            Some((serial, status))
        })
        .collect();

    let serial = match serial.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(requested) => match available.iter().find(|(s, _)| s == &requested) {
            Some((_, status)) if status == "device" => requested,
            Some((_, status)) => {
                return Err(err_arg("device_status", format!("{requested} ({status})")))
            }
            None => {
                // A wireless phone re-registers under a new name whenever its IP or
                // debug port changes, so a pinned serial goes stale on its own. With
                // a single usable device there is nothing to guess wrong.
                let mut usable = available
                    .iter()
                    .filter(|(_, status)| status == "device")
                    .map(|(serial, _)| serial.clone());
                match (usable.next(), usable.next()) {
                    (Some(only), None) => only,
                    _ => return Err(err_arg("device_gone", requested)),
                }
            }
        },
        None => match available.iter().find(|(_, status)| status == "device") {
            Some((serial, _)) => serial.clone(),
            None => {
                if available.iter().any(|(_, status)| status == "unauthorized") {
                    return Err("USB Debugging not authorised. Check the confirmation dialog on your phone.".into());
                }
                return Err(
                    "No Android device detected. Connect your phone via USB and enable USB Debugging.".into(),
                );
            }
        },
    };

    // Store the serial so all subsequent ADB calls (including stop_daemon) target this device.
    if let Ok(mut guard) = DEVICE_SERIAL.lock() {
        *guard = Some(serial.clone());
    }

    // 2 — Kill any zombie daemon before we push/start.
    let _ = adb_s(&adb_path, &["shell", "pkill -f '[s]ocketsweep_daemon' || true"]);

    // 2.5 — Automate MANAGE_EXTERNAL_STORAGE permission for the shell user.
    let _ = adb_s(&adb_path, &["shell", "appops set com.android.shell MANAGE_EXTERNAL_STORAGE allow"]);

    // 4 — Push binary to device.
    adb_s(&adb_path, &["push", &daemon_src.to_string_lossy(), DEVICE_BIN_PATH])?;

    // 5 — Make it executable.
    adb_s(&adb_path, &["shell", "chmod", "+x", DEVICE_BIN_PATH])?;

    // 5 — Kill any previously running instance (ignore errors).
    let _ = adb_s(&adb_path, &["shell", "pkill", "-f", "'[s]ocketsweep_daemon'"]);
    std::thread::sleep(Duration::from_millis(300));

    // 6 — Start the daemon in the background on the device.
    let start_cmd = format!("nohup {DEVICE_BIN_PATH} > /dev/null 2>&1 & echo $!; exit");
    let pid_output = adb_s(&adb_path, &["shell", &start_cmd])?;
    let pid = pid_output.trim().to_string();

    // 7 — Set up the USB TCP tunnel.
    adb_s(&adb_path, &["forward", &format!("tcp:{DAEMON_PORT}"), &format!("tcp:{DAEMON_PORT}")])?;

    // 8 — Ping-Retry loop.
    let mut pong = String::new();
    let mut connected_daemon = false;
    for _ in 0..15 {
        std::thread::sleep(Duration::from_millis(150));
        match daemon_command("PING") {
            Ok(res) => {
                pong = res;
                connected_daemon = true;
                break;
            }
            Err(_) => continue,
        }
    }

    if !connected_daemon {
        return Err("Daemon started but failed to respond to PING over TCP tunnel.".into());
    }

    Ok(format!(
        "{{\"daemon_pid\":\"{pid}\",\"serial\":\"{serial}\",\"ping_response\":{pong}}}"
    ))
}

#[tauri::command(async)]
fn run_scan(path: Option<String>) -> Result<String, String> {
    let effective_root = match path {
        Some(ref p) if !p.is_empty() => p.clone(),
        _ => "/sdcard".to_string(), // daemon default
    };
    let cmd = format!("SCAN {effective_root}");
    let response = match daemon_command(&cmd) {
        Ok(answer) => answer,
        // A wireless tunnel that breaks mid-transfer leaves a truncated answer.
        // Asking once more beats making him press the button again; a second
        // failure is a real problem and goes to him as one.
        Err(e) if e.starts_with("E#inflate_failed") => daemon_command(&cmd)?,
        Err(e) => return Err(e),
    };

    // Store the scan root so delete_item can guard against it.
    if let Ok(mut root) = SCAN_ROOT.lock() {
        *root = Some(effective_root);
    }

    Ok(response)
}

#[tauri::command]
fn ping_daemon() -> Result<String, String> {
    daemon_command("PING")
}

#[tauri::command]
fn stop_daemon(app: tauri::AppHandle) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let response = daemon_command("SHUTDOWN").unwrap_or_else(|_| "daemon already stopped".into());
    let _ = adb_s(&adb_path, &["forward", "--remove", &format!("tcp:{DAEMON_PORT}")]);
    let _ = adb_s(&adb_path, &["shell", "rm", DEVICE_BIN_PATH]);
    Ok(response)
}

#[tauri::command(async)]
fn get_storage_info(app: tauri::AppHandle) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let output = adb_s(&adb_path, &["shell", "df -k /sdcard"])?;

    // `df -k` prints a header then one row per mount; prefer the row we asked about.
    let header_kb = output.lines().next().map(|l| l.contains("1K-blocks")).unwrap_or(false);
    let row = output
        .lines()
        .skip(1)
        .find(|l| l.contains("/storage") || l.contains("/sdcard"))
        .or_else(|| output.lines().nth(1))
        .ok_or("Failed to read device storage capacity: empty df output")?;

    let cols: Vec<&str> = row.split_whitespace().collect();
    if cols.len() < 4 {
        return Err(format!("Failed to read device storage capacity: unparsable df row '{row}'"));
    }
    if !header_kb {
        return Err(format!("Failed to read device storage capacity: df did not report 1K blocks ({row})"));
    }

    let parse_kb = |v: &str| -> Result<i64, String> {
        v.parse::<i64>()
            .map(|kb| kb * 1024)
            .map_err(|e| format!("Failed to read device storage capacity: bad value '{v}' ({e})"))
    };

    Ok(format!(
        "{{\"total_bytes\":{},\"used_bytes\":{},\"free_bytes\":{}}}",
        parse_kb(cols[1])?,
        parse_kb(cols[2])?,
        parse_kb(cols[3])?,
    ))
}

#[tauri::command]
fn delete_item(path: String) -> Result<String, String> {
    // Prevent deletion of the scan root directory.
    if let Ok(root) = SCAN_ROOT.lock() {
        if let Some(ref scan_root) = *root {
            if path == *scan_root {
                return Err("Cannot delete the scan root directory.".into());
            }
        }
    }
    daemon_command(&format!("DELETE {path}"))
}

/// Quotes nothing and trusts nothing: a file name straight off someone's disk
/// ends up inside a shell string on the device, so the shell metacharacters go.
fn safe_remote_name(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '\'' | '"' | '$' | '`' | ';' | '|' | '&' | '\\' | '<' | '>' | '?' | '*' | ':' | '\n' | '\r' => '_',
            other => other,
        })
        .collect()
}

/// Quote a path for the device's `/system/bin/sh`. Apostrophes are the trap — a
/// folder called `1'sdcard` silently breaks a plain `'…'` wrapper — so each one
/// becomes the standard `'\''` sequence.
fn shell_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', r"'\''"))
}

fn device_shell(adb_path: &std::path::Path, script: String) -> Result<String, String> {
    let serial = device_serial();
    let mut args: Vec<&str> = Vec::new();
    if let Some(ref serial) = serial {
        args.push("-s");
        args.push(serial.as_str());
    }
    args.push("shell");
    args.push(script.as_str());
    adb(adb_path, &args)
}

/// The first name in `device_dir` that does not already exist on the phone.
/// Overwriting a file the user never asked us to touch is not on the table.
fn free_remote_name(adb_path: &std::path::Path, dir: &str, name: &str) -> Result<String, String> {
    let (stem, ext) = match name.rsplit_once('.') {
        Some((head, tail)) if !head.is_empty() => (head.to_string(), Some(tail.to_string())),
        _ => (name.to_string(), None),
    };
    let mut index = 1;
    loop {
        let candidate = match (&stem, &ext) {
            (s, Some(e)) if index == 1 => format!("{s}.{e}"),
            (s, Some(e)) => format!("{s} ({index}).{e}"),
            (s, None) if index == 1 => s.clone(),
            (s, None) => format!("{s} ({index})"),
        };
        let probe = format!("test -e {} && echo TAKEN || echo FREE", shell_quote(&format!("{dir}/{candidate}")));
        let answer = device_shell(adb_path, probe).unwrap_or_else(|_| "FREE".into());
        if answer.contains("FREE") {
            return Ok(candidate);
        }
        index += 1;
        if index > 50 {
            return Err(err("too_many_names"));
        }
    }
}

/// base64 without pulling in a codec crate: this only ever encodes, and only
/// from the byte head `peek_file` reads off the phone.
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (b[0] as u32) << 16 | (b[1] as u32) << 8 | b[2] as u32;
        out.push(TABLE[(n >> 18 & 63) as usize] as char);
        out.push(TABLE[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Reads the first `limit` bytes of a device file. A phone photo keeps a small
/// preview inside its own header, so the interface can show a thumbnail without
/// pulling the whole picture across adb.
#[tauri::command(async)]
fn peek_file(app: tauri::AppHandle, device_path: String, limit: u32) -> Result<String, String> {
    if !device_path.starts_with("/sdcard") {
        return Err(err("peek_outside_sdcard"));
    }
    let adb_path = get_bundled_binary(&app, "adb")?;
    let blocks = (limit / 1024).clamp(1, 512);
    let command = format!("dd if={} bs=1024 count={} 2>/dev/null", shell_quote(&device_path), blocks);

    let mut args: Vec<String> = Vec::new();
    if let Some(ref serial) = device_serial() {
        args.push("-s".into());
        args.push(serial.clone());
    }
    args.push("exec-out".into());
    args.push(command);

    let output = hide_console(Command::new(&adb_path))
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .output()
        .map_err(|e| err_arg("peek_failed", e))?;
    if !output.status.success() && output.stdout.is_empty() {
        return Err(err("peek_failed_empty"));
    }
    Ok(base64(&output.stdout))
}

/// Sizes of the files about to be uploaded. The front end adds them up and
/// compares against the phone's free space before any byte is sent.
#[tauri::command(async)]
fn local_file_sizes(paths: Vec<String>) -> Result<String, String> {
    let out: Vec<serde_json::Value> = paths
        .iter()
        .map(|path| {
            let bytes = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
            serde_json::json!({ "path": path, "bytes": bytes })
        })
        .collect();
    serde_json::to_string(&out).map_err(|e| format!("Failed to report file sizes: {e}"))
}

/// Stats the files this app pulled, newest first. The download folder is the
/// user's own and holds whatever he put there, so the panel lists recorded
/// paths rather than the folder — and a file he moved or deleted just drops off.
#[tauri::command(async)]
fn stat_paths(paths: Vec<String>) -> String {
    let mut out: Vec<Listed> = paths
        .iter()
        .filter_map(|path| {
            let meta = std::fs::metadata(path).ok()?;
            if !meta.is_file() {
                return None;
            }
            Some(Listed {
                name: std::path::Path::new(path).file_name()?.to_str()?.to_string(),
                bytes: meta.len(),
                mtime: meta.modified().ok().map(epoch_secs).unwrap_or(0),
                path: path.clone(),
            })
        })
        .collect();
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    serde_json::to_string(&out).unwrap_or_else(|_| "[]".into())
}

/// Copies a local file into a folder on the phone and reports progress.
#[tauri::command(async)]
fn push_file(app: tauri::AppHandle, local_path: String, device_dir: String) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    if !device_dir.starts_with("/sdcard") {
        return Err(err("upload_outside_sdcard"));
    }
    let source = std::path::PathBuf::from(&local_path);
    let meta = std::fs::metadata(&source).map_err(|e| err_arg("local_stat_failed", e))?;
    if !meta.is_file() {
        return Err(err("upload_not_file"));
    }
    let size = meta.len() as i64;
    let dir = device_dir.trim_end_matches('/');
    let raw = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| err("name_unreadable"))?;
    let target = free_remote_name(&adb_path, dir, &safe_remote_name(raw))?;
    let remote = format!("{dir}/{target}");

    let serial = device_serial();
    let mut args: Vec<String> = Vec::new();
    if let Some(ref serial) = serial {
        args.push("-s".into());
        args.push(serial.clone());
    }
    args.push("push".into());
    args.push(local_path.clone());
    args.push(remote.clone());

    CANCEL_TRANSFER.store(false, Ordering::Relaxed);
    let mut child = hide_console(Command::new(&adb_path))
        .args(&args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| err_arg("push_start_failed", e))?;

    let pushed = wait_for_transfer(
        &app,
        &mut child,
        "push-progress",
        &local_path,
        size,
        "push",
        &|| {
            let probe = format!("stat -c %s {} 2>/dev/null", shell_quote(&remote));
            device_shell(&adb_path, probe)
                .ok()
                .and_then(|text| text.trim().parse::<i64>().ok())
                .unwrap_or(0)
        },
        // The half-written file is on the phone, not here.
        None,
    );
    if let Err(err) = pushed {
        // Leave no truncated copy behind on the device.
        let _ = device_shell(&adb_path, format!("rm -f {}", shell_quote(&remote)));
        return Err(err);
    }

    Ok(serde_json::json!({ "remote": remote, "name": target, "bytes": size }).to_string())
}

/// Moves the given device paths into `dest` with `mv`.
///
/// A move removes the original path, so this is the one write command that can
/// lose data if it is careless: it refuses anything outside /sdcard, refuses to
/// move a folder into itself, and refuses to overwrite a name that is already
/// taken at the destination rather than quietly renaming.
#[tauri::command(async)]
fn move_items(app: tauri::AppHandle, paths: Vec<String>, dest: String) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let dest = dest.trim_end_matches('/').to_string();
    if !dest.starts_with("/sdcard") || dest.is_empty() {
        return Err(err("move_outside_sdcard"));
    }

    let mut moved: Vec<serde_json::Value> = Vec::new();
    let mut failed: Vec<String> = Vec::new();

    for path in &paths {
        let source = path.trim_end_matches('/').to_string();
        let name = match source.rsplit_once('/') {
            Some((_, tail)) if !tail.is_empty() => tail.to_string(),
            _ => {
                failed.push(err_arg("move_name_unreadable", source));
                continue;
            }
        };
        if !source.starts_with("/sdcard/") || source == "/sdcard" {
            failed.push(err_arg("move_outside_sdcard_item", source));
            continue;
        }
        if source == dest {
            failed.push(err_arg("move_already_there", source));
            continue;
        }
        // Moving a folder into one of its own children would take it with us.
        if dest.starts_with(&format!("{source}/")) {
            failed.push(err_arg("move_into_itself", source));
            continue;
        }

        let target = format!("{dest}/{name}");
        let probe = format!("test -e {} && echo TAKEN || echo FREE", shell_quote(&target));
        match device_shell(&adb_path, probe) {
            Ok(answer) if answer.contains("TAKEN") => {
                failed.push(err_arg("move_name_taken", name));
                continue;
            }
            Err(err) => {
                failed.push(format!("{name}:{err}"));
                continue;
            }
            _ => {}
        }

        let script = format!("mv -- {} {} && echo MOVED", shell_quote(&source), shell_quote(&format!("{dest}/")));
        match device_shell(&adb_path, script) {
            Ok(out) if out.contains("MOVED") => moved.push(serde_json::json!({
                "from": source,
                "to": target,
                "name": name,
            })),
            Ok(_) => failed.push(err_arg("move_refused", name)),
            Err(err) => failed.push(format!("{name}:{err}")),
        }
    }

    Ok(serde_json::json!({ "moved": moved, "failed": failed }).to_string())
}

// ── Device management (USB + wireless adb) ──────────────────────────────────

#[derive(serde::Serialize)]
struct DeviceInfo {
    serial: String,
    model: String,
    kind: String,
    status: String,
    /// Every adb transport that belongs to this one phone.
    transports: Vec<String>,
    #[serde(skip)]
    key: String,
}

#[tauri::command(async)]
fn list_devices(app: tauri::AppHandle) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let output = adb(&adb_path, &["devices", "-l"])?;
    let pinned = device_serial();

    let mut groups: Vec<DeviceInfo> = Vec::new();
    // `adb devices -l` pads columns with spaces, so split on whitespace rather
    // than relying on the tab that plain `adb devices` uses.
    for line in output.lines().skip(1) {
        let mut cols = line.trim().split_whitespace();
        let (Some(serial), Some(status)) = (cols.next(), cols.next()) else { continue };
        if serial == "List" || serial.starts_with('*') {
            continue;
        }
        let rest: Vec<&str> = cols.collect();
        let field = |name: &str| rest.iter().find_map(|c| c.strip_prefix(name)).unwrap_or_default();
        let model = field("model:").replace('_', " ");
        // One phone can hold several transports at once — plugged in, paired over
        // Wi-Fi, discovered by mDNS — and they all report the same product/model.
        // Showing them as separate devices reads like a bug and invites picking
        // the wrong one, so they collapse into a single row.
        let key = match (field("product:"), model.as_str()) {
            ("", "") => format!("#{serial}"),
            (product, model) => format!("{product}|{model}"),
        };
        if let Some(group) = groups.iter_mut().find(|d| d.key == key) {
            group.transports.push(serial.to_string());
            if group.status != "device" && status == "device" {
                group.status = status.to_string();
            }
            continue;
        }
        let wireless = pairing::is_wireless_serial(serial);
        groups.push(DeviceInfo {
            serial: serial.to_string(),
            model,
            kind: if wireless { "wireless".into() } else { "usb".into() },
            status: status.to_string(),
            transports: vec![serial.to_string()],
            key,
        });
    }

    for group in groups.iter_mut() {
        // A phone on the cable *and* on Wi-Fi is faster and steadier over USB, so
        // the row leads with the wired transport when both are alive.
        let chosen = pinned
            .as_ref()
            .filter(|pinned| group.transports.iter().any(|t| t.as_str() == pinned.as_str()))
            .cloned()
            .or_else(|| {
                group
                    .transports
                    .iter()
                    .find(|t| !pairing::is_wireless_serial(t))
                    .cloned()
            })
            .or_else(|| {
                group
                    .transports
                    .iter()
                    .find(|t| t.contains("_adb-tls-connect"))
                    .cloned()
            })
            .or_else(|| group.transports.iter().find(|t| t.contains(':')).cloned())
            .unwrap_or_else(|| group.serial.clone());
        group.serial = chosen;
        group.kind = if pairing::is_wireless_serial(&group.serial) { "wireless".into() } else { "usb".into() };
    }

    serde_json::to_string(&groups).map_err(|e| format!("Failed to describe devices: {e}"))
}

#[tauri::command(async)]
fn pair_device(app: tauri::AppHandle, target: String, code: String) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let code = code.chars().filter(|c| c.is_ascii_digit()).collect::<String>();
    if code.len() != 6 {
        return Err(err("pair_code_length"));
    }
    if !target.contains(':') {
        return Err(err("pair_target_format"));
    }
    adb(&adb_path, &["pair", target.trim(), &code])
}

#[tauri::command(async)]
fn connect_device(app: tauri::AppHandle, target: String) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let target = target.trim().to_string();
    if target.is_empty() {
        return Err(err("connect_target_format"));
    }
    adb(&adb_path, &["connect", &target])
}

#[tauri::command(async)]
fn disconnect_device(app: tauri::AppHandle, target: String) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    adb(&adb_path, &["disconnect", target.trim()])
}

// ── Local cache & opening device files on the PC ────────────────────────────
// The daemon only reports metadata, so viewing a file on the PC means pulling
// its contents first. Pulled files live in a cache we can reopen instantly.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;

/// Where pulled copies live. The settings page can point either at any folder;
/// `None` keeps the platform default so nothing breaks before it is configured.
static CACHE_PATH: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);
static DOWNLOAD_PATH: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);
static CLEAR_CACHE_ON_EXIT: AtomicBool = AtomicBool::new(false);

fn configured(slot: &Mutex<Option<std::path::PathBuf>>) -> Option<std::path::PathBuf> {
    slot.lock().ok().and_then(|guard| guard.clone())
}

/// The unconfigured home for both folders. `SOCKETSWEEP_CACHE_DIR` exists so a
/// dev build can keep its scratch files off the system drive.
fn default_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if let Ok(custom) = std::env::var("SOCKETSWEEP_CACHE_DIR") {
        if !custom.is_empty() {
            return Ok(std::path::PathBuf::from(custom));
        }
    }
    app.path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to locate a local folder: {e}"))
        .map(|dir| dir.join("socketsweep"))
}

fn ensure_dir(path: std::path::PathBuf, label: &str) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(&path)
        .map_err(|e| err_arg(&format!("dir_create_failed_{label}"), format!("{path:?} — {e}")))?;
    Ok(path)
}

fn cache_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    match configured(&CACHE_PATH) {
        Some(path) => ensure_dir(path, "cache"),
        None => ensure_dir(default_root(app)?, "cache"),
    }
}

fn download_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    match configured(&DOWNLOAD_PATH) {
        Some(path) => ensure_dir(path, "download"),
        None => ensure_dir(default_root(app)?.join("downloads"), "download"),
    }
}

#[derive(serde::Serialize)]
struct Paths {
    cache: String,
    download: String,
    cache_custom: bool,
    download_custom: bool,
    clear_on_exit: bool,
}

fn describe_paths(app: &tauri::AppHandle) -> Result<Paths, String> {
    Ok(Paths {
        cache: cache_dir(app)?.to_string_lossy().into_owned(),
        download: download_dir(app)?.to_string_lossy().into_owned(),
        cache_custom: configured(&CACHE_PATH).is_some(),
        download_custom: configured(&DOWNLOAD_PATH).is_some(),
        clear_on_exit: CLEAR_CACHE_ON_EXIT.load(Ordering::Relaxed),
    })
}

/// Every file inside the cache folder belongs to us, because configuring a
/// folder that already holds files is refused — see `pick`.
fn cache_dir_has_foreign_files(dir: &std::path::Path) -> bool {
    std::fs::read_dir(dir)
        .map(|entries| entries.flatten().any(|entry| entry.path().is_file()))
        .unwrap_or(false)
}

fn pick(
    slot: &Mutex<Option<std::path::PathBuf>>,
    value: Option<String>,
    label: &str,
    must_be_empty: bool,
) -> Result<(), String> {
    let Some(value) = value else { return Ok(()) };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        *slot.lock().map_err(|_| err("path_lock"))? = None;
        return Ok(());
    }
    // The folder gets swept by the cap and by clear-on-exit, so refuse the places
    // where that would be a catastrophe and refuse folders holding other things.
    let candidate = std::path::PathBuf::from(trimmed);
    if candidate.parent().is_none() {
        return Err(err(&format!("path_is_drive_root_{label}")));
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(std::path::PathBuf::from)
        .unwrap_or_default();
    if !home.as_os_str().is_empty() && candidate == home {
        return Err(err(&format!("path_is_home_{label}")));
    }
    ensure_dir(candidate.clone(), label)?;
    if must_be_empty && cache_dir_has_foreign_files(&candidate) {
        return Err(err(&format!("path_not_empty_{label}")));
    }
    *slot.lock().map_err(|_| err("path_lock"))? = Some(candidate);
    Ok(())
}

/// Reads or updates the two folders and the exit switch in one round trip; the
/// UI sends only the fields it is changing and always gets the full state back.
#[tauri::command(async)]
fn set_paths(
    app: tauri::AppHandle,
    cache: Option<String>,
    download: Option<String>,
    clear_on_exit: Option<bool>,
) -> Result<String, String> {
    pick(&CACHE_PATH, cache, "cache", true)?;
    pick(&DOWNLOAD_PATH, download, "download", false)?;
    if let Some(flag) = clear_on_exit {
        CLEAR_CACHE_ON_EXIT.store(flag, Ordering::Relaxed);
    }
    serde_json::to_string(&describe_paths(&app)?).map_err(|e| e.to_string())
}

/// Which of the two folders a command should act on.
fn dir_for(app: &tauri::AppHandle, kind: &str) -> Result<std::path::PathBuf, String> {
    match kind {
        "download" => download_dir(app),
        _ => cache_dir(app),
    }
}

#[tauri::command(async)]
fn dir_stats(app: tauri::AppHandle, kind: String) -> Result<String, String> {
    let dir = dir_for(&app, &kind)?;
    let mut files = 0u64;
    let mut bytes = 0u64;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    files += 1;
                    bytes += meta.len();
                }
            }
        }
    }
    Ok(serde_json::json!({ "files": files, "bytes": bytes, "path": dir.to_string_lossy() }).to_string())
}

/// FNV-1a over the device path, mixed into the cached file name. Flattening
/// alone is lossy — `/sdcard/a/b.jpg` and `/sdcard/a_b.jpg` both become
/// `sdcard_a_b.jpg` — and a collision silently opens the wrong copy. The front
/// end recomputes the same value, so both sides must agree exactly.
fn fnv1a32(text: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in text.as_bytes() {
        hash ^= *byte as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// `/sdcard/DCIM/a.jpg` → `sdcard_DCIM_a-3f2a1b9c.jpg`.
fn cached_file_name(device_path: &str) -> String {
    let flat: String = device_path
        .trim_start_matches('/')
        .replace('/', "_")
        .chars()
        .map(|c| match c {
            ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    let tag = format!("-{:08x}", fnv1a32(device_path));
    match flat.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < flat.len() => format!("{}{}{}", &flat[..dot], tag, &flat[dot..]),
        _ => format!("{flat}{tag}"),
    }
}

#[derive(serde::Serialize)]
struct CachedEntry {
    name: String,
    bytes: u64,
    mtime: i64,
}

/// What the cache folder holds, so the front end can mark a row 已缓存 only when
/// the copy really matches the file on the phone.
#[tauri::command(async)]
fn cached_entries(app: tauri::AppHandle) -> Result<String, String> {
    let mut out = Vec::new();
    for (path, len, mtime) in dir_entries(&cache_dir(&app)?) {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        out.push(CachedEntry { name: name.to_string(), bytes: len, mtime });
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

fn epoch_secs(at: std::time::SystemTime) -> i64 {
    at.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Files directly inside a folder, newest first, with their size and mtime.
fn dir_entries(dir: &std::path::Path) -> Vec<(std::path::PathBuf, u64, i64)> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let mtime = epoch_secs(meta.modified().unwrap_or(std::time::UNIX_EPOCH));
        out.push((path, meta.len(), mtime));
    }
    out.sort_by(|a, b| b.2.cmp(&a.2));
    out
}

#[derive(serde::Serialize)]
struct Listed {
    name: String,
    bytes: u64,
    mtime: i64,
    path: String,
}

/// Deletes cached copies, oldest first, until the folder fits under
/// `limit_bytes`; `all` empties it. Safe to sweep because a folder holding other
/// files can never be chosen as the cache location.
fn clear_cache(app: &tauri::AppHandle, limit_bytes: i64, all: bool) -> Result<(u64, u64, u64), String> {
    let mut ours = dir_entries(&cache_dir(app)?);
    ours.sort_by_key(|(_, _, mtime)| *mtime);

    let mut total: u64 = ours.iter().map(|(_, len, _)| *len).sum();
    let limit = limit_bytes.max(0) as u64;
    let mut removed = 0u64;
    let mut freed = 0u64;

    for (path, len, _) in ours {
        if !all && total <= limit {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
            removed += 1;
            freed += len;
        }
    }
    Ok((removed, freed, total))
}

#[tauri::command(async)]
fn trim_cache(app: tauri::AppHandle, limit_bytes: i64, all: bool) -> Result<String, String> {
    let (removed, freed, bytes) = clear_cache(&app, limit_bytes, all)?;
    Ok(serde_json::json!({ "removed": removed, "freed": freed, "bytes": bytes }).to_string())
}

/// Free bytes on the volume holding one of our folders. Checked before a pull
/// because an `adb pull` that runs out of disk fails halfway and leaves a
/// truncated file behind.
#[cfg(windows)]
fn volume_free(path: &std::path::Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let (mut available, mut total, mut total_free) = (0u64, 0u64, 0u64);
    let ok = unsafe {
        windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            &mut total,
            &mut total_free,
        )
    };
    (ok != 0).then_some(available)
}

#[cfg(not(windows))]
fn volume_free(path: &std::path::Path) -> Option<u64> {
    let out = Command::new("df").args(["-kP", &path.to_string_lossy()]).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let avail = text.lines().last()?.split_whitespace().nth(3)?.parse::<u64>().ok()?;
    Some(avail * 1024)
}

#[tauri::command(async)]
fn disk_free(app: tauri::AppHandle, kind: String) -> Result<String, String> {
    let dir = dir_for(&app, &kind)?;
    let free = volume_free(&dir).ok_or_else(|| err_arg("disk_free_unreadable", dir.display().to_string()))?;
    Ok(serde_json::json!({ "path": dir.to_string_lossy(), "free": free }).to_string())
}

/// Picks a name inside the download folder: reuses a byte-identical copy that is
/// already there, and never overwrites a different file that shares the name.
fn download_target(dir: &std::path::Path, device_path: &str, size: i64) -> std::path::PathBuf {
    let base = device_path.rsplit('/').next().unwrap_or(device_path);
    let safe: String = base
        .chars()
        .map(|c| match c {
            ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect();
    let (stem, ext) = match safe.rsplit_once('.') {
        Some((head, tail)) if !head.is_empty() && !tail.is_empty() => (head.to_string(), Some(tail.to_string())),
        _ => (safe.clone(), None),
    };

    let mut index = 1usize;
    loop {
        let name = match (&stem, &ext) {
            (_, Some(_)) if index == 1 => safe.clone(),
            (_, Some(e)) => format!("{stem} ({index}).{e}"),
            (s, None) if index == 1 => s.clone(),
            (s, None) => format!("{s} ({index})"),
        };
        let candidate = dir.join(name);
        match candidate.metadata() {
            Ok(meta) if meta.len() as i64 == size => return candidate,
            Ok(_) => index += 1,
            Err(_) => return candidate,
        }
    }
}

/// Set by the transfer panel's 取消 button; the running pull/poll loop kills the
/// adb child as soon as it sees it.
static CANCEL_TRANSFER: AtomicBool = AtomicBool::new(false);

#[tauri::command(async)]
fn cancel_transfer() -> Result<String, String> {
    CANCEL_TRANSFER.store(true, Ordering::Relaxed);
    Ok("{\"status\":\"cancelling\"}".into())
}

/// Poll an adb child until it exits, reporting `done` bytes as it goes so the UI
/// can show progress, and honouring the cancel switch.
fn wait_for_transfer(
    app: &tauri::AppHandle,
    child: &mut std::process::Child,
    event: &str,
    key: &str,
    size: i64,
    what: &str,
    probe: &dyn Fn() -> i64,
    partial: Option<&std::path::Path>,
) -> Result<(), String> {
    while let Ok(None) = child.try_wait() {
        if CANCEL_TRANSFER.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(path) = partial {
                let _ = std::fs::remove_file(path);
            }
            return Err(err("cancelled"));
        }
        let done = probe();
        let _ = app.emit(
            event,
            serde_json::json!({ "path": key, "done": done, "total": size }),
        );
        std::thread::sleep(Duration::from_millis(250));
    }
    let status = child
        .wait()
        .map_err(|e| err_arg(&format!("{what}_wait_failed"), e))?;
    if !status.success() {
        if let Some(path) = partial {
            let _ = std::fs::remove_file(path);
        }
        return Err(err(&format!("{what}_failed")));
    }
    Ok(())
}

/// Pulls `device_path` to the PC, reporting progress as it goes, and optionally
/// hands it to the OS default application. Returns the local path.
///
/// `kind` chooses the folder: "cache" is auto-trimmed scratch space for opening
/// files, "download" keeps the copy under its own name.
#[tauri::command(async)]
fn pull_file(
    app: tauri::AppHandle,
    device_path: String,
    size: i64,
    mtime: i64,
    open: bool,
    kind: Option<String>,
) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;

    let adb_path = get_bundled_binary(&app, "adb")?;
    let to_download = kind.as_deref() == Some("download");
    let local = if to_download {
        download_target(&download_dir(&app)?, &device_path, size)
    } else {
        cache_dir(&app)?.join(cached_file_name(&device_path))
    };
    let local_str = local
        .to_str()
        .ok_or_else(|| format!("Local path is not valid text: {:?}", local))?
        .to_string();

    // A copy is only reusable when it matches both the size and the phone's own
    // modification time; size alone would serve a stale file forever.
    let already_there = size > 0
        && local
            .metadata()
            .map(|meta| {
                meta.len() as i64 == size
                    && (mtime <= 0
                        || epoch_secs(meta.modified().unwrap_or(std::time::UNIX_EPOCH)) == mtime)
            })
            .unwrap_or(false);

    if !already_there {
        let _ = std::fs::remove_file(&local);
        // Always name the transport: a phone that is paired over Wi-Fi *and*
        // plugged in shows up twice, and a bare `adb pull` then fails with
        // "more than one device/emulator".
        let serial = device_serial();
        let mut args: Vec<&str> = Vec::new();
        if let Some(ref serial) = serial {
            args.push("-s");
            args.push(serial.as_str());
        }
        args.extend(["pull", device_path.as_str(), local_str.as_str()]);

        CANCEL_TRANSFER.store(false, Ordering::Relaxed);
        let mut child = hide_console(Command::new(&adb_path))
            .args(&args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to start adb pull: {e}"))?;

        wait_for_transfer(
            &app,
            &mut child,
            "pull-progress",
            &device_path,
            size,
            "pull",
            &|| std::fs::metadata(&local).map(|m| m.len() as i64).unwrap_or(0),
            Some(&local),
        )?;

        // Give the copy the phone's timestamp so the next comparison means something.
        if mtime > 0 {
            if let Ok(handle) = std::fs::OpenOptions::new().write(true).open(&local) {
                let when = std::time::UNIX_EPOCH + std::time::Duration::from_secs(mtime as u64);
                let _ = handle.set_modified(when);
            }
        }
    }

    let _ = app.emit(
        "pull-progress",
        serde_json::json!({ "path": device_path, "done": size, "total": size }),
    );

    if open {
        app.opener()
            .open_path(&local_str, None::<&str>)
            .map_err(|e| err_arg("open_after_pull_failed", e))?;
    }

    Ok(local_str)
}

#[tauri::command(async)]
fn reveal_folder(app: tauri::AppHandle, kind: String) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = dir_for(&app, &kind)?;
    let path = dir
        .to_str()
        .ok_or_else(|| format!("Path is not valid text: {:?}", dir))?
        .to_string();
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| err_arg("reveal_failed", e))?;
    Ok(path)
}

#[tauri::command(async)]
fn start_qr_pairing(app: tauri::AppHandle) -> Result<String, String> {
    let (svg, text) = pairing::start(app)?;
    Ok(format!(
        "{{\"svg\":{},\"text\":{}}}",
        serde_json::to_string(&svg).unwrap_or_default(),
        serde_json::to_string(&text).unwrap_or_default()
    ))
}

#[tauri::command(async)]
fn cancel_qr_pairing() -> Result<String, String> {
    pairing::cancel();
    Ok("{\"status\":\"cancelled\"}".into())
}

/// The wireless button's first move: connect without the user touching anything.
#[tauri::command(async)]
fn wireless_auto_connect(app: tauri::AppHandle) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let result = pairing::auto_connect(&adb_path)?;
    serde_json::to_string(&result).map_err(|e| format!("Failed to report devices: {e}"))
}

// ── Tauri entry point ───────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            check_adb,
            init_daemon,
            run_scan,
            get_storage_info,
            ping_daemon,
            stop_daemon,
            delete_item,
            move_items,
            push_file,
            local_file_sizes,
            stat_paths,
            peek_file,
            list_devices,
            pair_device,
            connect_device,
            disconnect_device,
            start_qr_pairing,
            cancel_qr_pairing,
            wireless_auto_connect,
            set_paths,
            dir_stats,
            disk_free,
            cached_entries,
            trim_cache,
            pull_file,
            cancel_transfer,
            reveal_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Emptying the cache on exit only happens because the settings page
            // asked for it; downloads are never touched here.
            if matches!(event, tauri::RunEvent::Exit) && CLEAR_CACHE_ON_EXIT.load(Ordering::Relaxed) {
                let _ = clear_cache(app, 0, true);
            }
        });
}
