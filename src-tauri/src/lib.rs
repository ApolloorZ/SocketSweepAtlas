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

/// Run an ADB command and return its stdout. Maps any failure to a
/// human-readable `Err(String)`.
pub(crate) fn adb(adb_path: &std::path::Path, args: &[&str]) -> Result<String, String> {
    use std::io::Read;
    use std::time::{Duration, Instant};

    let mut child = Command::new(adb_path)
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
fn adb_s(adb_path: &std::path::Path, args: &[&str]) -> Result<String, String> {
    if let Ok(guard) = DEVICE_SERIAL.lock() {
        if let Some(ref serial) = *guard {
            let mut full_args = vec!["-s", serial.as_str()];
            full_args.extend_from_slice(args);
            return adb(adb_path, &full_args);
        }
    }
    adb(adb_path, args)
}

// ── TCP helper ──────────────────────────────────────────────────────────────

/// Send a one-line command to the daemon and read the full response.
fn daemon_command(cmd: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect_timeout(
        &DAEMON_ADDR.parse().unwrap(),
        TCP_CONNECT_TIMEOUT,
    )
    .map_err(|e| format!("Cannot connect to daemon at {DAEMON_ADDR}: {e}"))?;

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

    let mut response_bytes = Vec::with_capacity(1024 * 1024);
    stream
        .read_to_end(&mut response_bytes)
        .map_err(|e| format!("Failed to read daemon response: {e}"))?;

    let response = String::from_utf8_lossy(&response_bytes).trim().to_string();
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
                return Err(format!("设备 {requested} 当前状态是「{status}」,还不能用。"))
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
                    _ => return Err(format!("没有找到设备 {requested},请重新连接一次。")),
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
    let response = daemon_command(&cmd)?;

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

// ── Device management (USB + wireless adb) ──────────────────────────────────

#[derive(serde::Serialize)]
struct DeviceInfo {
    serial: String,
    model: String,
    kind: String,
    status: String,
}

#[tauri::command(async)]
fn list_devices(app: tauri::AppHandle) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let output = adb(&adb_path, &["devices", "-l"])?;

    let mut devices = Vec::new();
    // `adb devices -l` pads columns with spaces, so split on whitespace rather
    // than relying on the tab that plain `adb devices` uses.
    for line in output.lines().skip(1) {
        let line = line.trim();
        let mut cols = line.split_whitespace();
        let (Some(serial), Some(status)) = (cols.next(), cols.next()) else { continue };
        if serial == "List" || serial.starts_with('*') {
            continue;
        }
        let model = cols
            .find(|c| c.starts_with("model:"))
            .map(|c| c["model:".len()..].replace('_', " "))
            .unwrap_or_default();

        // Wireless devices appear either as ip:port or under the name adb gives an
        // mDNS-discovered transport, e.g. adb-982b7b0a-xxxx._adb-tls-connect._tcp
        let wireless = pairing::is_wireless_serial(serial);

        devices.push(DeviceInfo {
            serial: serial.to_string(),
            model,
            kind: if wireless { "wireless".into() } else { "usb".into() },
            status: status.to_string(),
        });
    }

    serde_json::to_string(&devices).map_err(|e| format!("Failed to describe devices: {e}"))
}

#[tauri::command(async)]
fn pair_device(app: tauri::AppHandle, target: String, code: String) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let code = code.chars().filter(|c| c.is_ascii_digit()).collect::<String>();
    if code.len() != 6 {
        return Err("配对码是手机上显示的那 6 位数字。".into());
    }
    if !target.contains(':') {
        return Err("请填写“IP:端口”,用无线调试配对界面上显示的那个地址。".into());
    }
    adb(&adb_path, &["pair", target.trim(), &code])
}

#[tauri::command(async)]
fn connect_device(app: tauri::AppHandle, target: String) -> Result<String, String> {
    let adb_path = get_bundled_binary(&app, "adb")?;
    let target = target.trim().to_string();
    if target.is_empty() {
        return Err("请填写手机“无线调试”页面上显示的 IP:端口。".into());
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
        .map_err(|e| format!("无法创建{label}文件夹 {path:?}:{e}"))?;
    Ok(path)
}

fn cache_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    match configured(&CACHE_PATH) {
        Some(path) => ensure_dir(path, "缓存"),
        None => ensure_dir(default_root(app)?, "缓存"),
    }
}

fn download_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    match configured(&DOWNLOAD_PATH) {
        Some(path) => ensure_dir(path, "下载"),
        None => ensure_dir(default_root(app)?.join("downloads"), "下载"),
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

fn pick(slot: &Mutex<Option<std::path::PathBuf>>, value: Option<String>, label: &str) -> Result<(), String> {
    let Some(value) = value else { return Ok(()) };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        *slot.lock().map_err(|_| format!("{label}设置无法保存"))? = None;
        return Ok(());
    }
    ensure_dir(std::path::PathBuf::from(trimmed), label)?;
    *slot.lock().map_err(|_| format!("{label}设置无法保存"))? = Some(std::path::PathBuf::from(trimmed));
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
    pick(&CACHE_PATH, cache, "缓存")?;
    pick(&DOWNLOAD_PATH, download, "下载")?;
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

/// Flattens a device path into a single safe file name, e.g.
/// `/sdcard/DCIM/a.jpg` → `sdcard_DCIM_a.jpg`.
fn cached_file_name(device_path: &str) -> String {
    device_path
        .trim_start_matches('/')
        .replace('/', "_")
        .chars()
        .map(|c| match c {
            ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            other => other,
        })
        .collect()
}

#[tauri::command(async)]
fn cached_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = cache_dir(&app)?;
    let mut names = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("Failed to read the cache folder: {e}"))?;
    for entry in entries.flatten() {
        if entry.path().is_file() {
            if let Some(name) = entry.file_name().to_str() {
                names.push(name.to_string());
            }
        }
    }
    Ok(names)
}

fn cache_files(app: &tauri::AppHandle) -> Result<Vec<(std::path::PathBuf, u64, std::time::SystemTime)>, String> {
    let dir = cache_dir(app)?;
    let mut out = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("读取缓存目录失败:{e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_file() {
            let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            out.push((path, meta.len(), mtime));
        }
    }
    Ok(out)
}

/// Deletes cached copies, oldest first, until the folder fits under
/// `limit_bytes`; `all` empties it regardless.
#[tauri::command(async)]
fn trim_cache(app: tauri::AppHandle, limit_bytes: i64, all: bool) -> Result<String, String> {
    let mut files = cache_files(&app)?;
    files.sort_by(|a, b| a.2.cmp(&b.2));
    let mut total: u64 = files.iter().map(|(_, len, _)| *len).sum();
    let limit = limit_bytes.max(0) as u64;
    let mut removed = 0u64;
    let mut freed = 0u64;

    for (path, len, _) in files {
        if !all && total <= limit {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total -= len;
            removed += 1;
            freed += len;
        }
    }

    Ok(serde_json::json!({ "removed": removed, "freed": freed, "bytes": total }).to_string())
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
    open: bool,
    kind: Option<String>,
) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;

    let adb_path = get_bundled_binary(&app, "adb")?;
    let local = if kind.as_deref() == Some("download") {
        download_target(&download_dir(&app)?, &device_path, size)
    } else {
        cache_dir(&app)?.join(cached_file_name(&device_path))
    };
    let local_str = local
        .to_str()
        .ok_or_else(|| format!("Local path is not valid text: {:?}", local))?
        .to_string();

    let already_cached = size > 0
        && local.is_file()
        && local.metadata().map(|m| m.len() as i64).unwrap_or(0) == size;

    if !already_cached {
        let _ = std::fs::remove_file(&local);
        let mut child = Command::new(&adb_path)
            .args(["pull", &device_path, &local_str])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Failed to start adb pull: {e}"))?;

        while let Ok(None) = child.try_wait() {
            let done = std::fs::metadata(&local).map(|m| m.len() as i64).unwrap_or(0);
            let _ = app.emit(
                "pull-progress",
                serde_json::json!({ "path": device_path, "done": done, "total": size }),
            );
            std::thread::sleep(Duration::from_millis(200));
        }

        let status = child
            .wait()
            .map_err(|e| format!("adb pull could not finish: {e}"))?;
        if !status.success() {
            let _ = std::fs::remove_file(&local);
            return Err(format!("adb pull failed for {device_path}"));
        }
    }

    let _ = app.emit(
        "pull-progress",
        serde_json::json!({ "path": device_path, "done": size, "total": size }),
    );

    if open {
        app.opener()
            .open_path(&local_str, None::<&str>)
            .map_err(|e| format!("文件已拉到电脑,但打不开:{}", e))?;
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
        .map_err(|e| format!("打不开这个文件夹:{e}"))?;
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
            list_devices,
            pair_device,
            connect_device,
            disconnect_device,
            start_qr_pairing,
            cancel_qr_pairing,
            wireless_auto_connect,
            set_paths,
            dir_stats,
            cached_files,
            trim_cache,
            pull_file,
            reveal_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // Emptying the cache on exit only happens because the settings page
            // asked for it; downloads are never touched here.
            if matches!(event, tauri::RunEvent::Exit) && CLEAR_CACHE_ON_EXIT.load(Ordering::Relaxed) {
                if let Ok(files) = cache_files(app) {
                    for (path, _, _) in files {
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
        });
}
