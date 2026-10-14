// ============================================================================
// lib.rs — SocketSweep Tauri Bridge (Phase 2)
// ============================================================================
// Orchestrates the C++ Android daemon via ADB and communicates with it
// over a TCP tunnel.  All commands return Result<String, String> so the
// React frontend can display meaningful error messages.
//
// Wire protocol (matches Phase 1 daemon):
// Every connection opens with "AUTH <session token>\n" and then one command.
//   → "PING\n"              ← {"status":"ok","message":"pong","protocol_version":3,"uid":…}
//   → "SCAN [path]\n"       ← gzip({"status":"ok","scan_time_ms":…,"scan_threads":…,
//                                   "skipped":…,"read_only":…,"tree":{…}})
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
/// Where the one-shot session secret is handed to the daemon. The daemon reads
/// and unlinks it before it accepts a single connection, so the secret never
/// appears in the process arguments the phone can list.
const DEVICE_TOKEN_PATH: &str = "/data/local/tmp/socketsweep_token";
/// The handshake version the bundled daemon announces. Version 3 is the one
/// that carries `--read-only`, `--threads` and the `skipped` counter; anything
/// else means the binary on the phone is not the one shipped with this build.
const DAEMON_PROTOCOL: u32 = 3;
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TCP_READ_TIMEOUT: Duration = Duration::from_secs(120); // scans can be slow

/// Tracks the root path of the last successful scan so we can prevent its deletion.
static SCAN_ROOT: Mutex<Option<String>> = Mutex::new(None);

/// Tracks the serial of the connected device so all ADB calls target the right device.
static DEVICE_SERIAL: Mutex<Option<String>> = Mutex::new(None);

/// The secret the running daemon expects on every connection. No token means no
/// session: nothing at all can be asked of the phone until one is handed out.
static SESSION_TOKEN: Mutex<Option<String>> = Mutex::new(None);

/// Connection changes, scans and deletes must not interleave. The daemon serves
/// one client at a time, so a restart while another command is in flight would
/// hand that command a daemon it never spoke to.
static DAEMON_OPERATION: Mutex<()> = Mutex::new(());

fn session_token() -> Result<String, String> {
    SESSION_TOKEN
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .ok_or_else(|| err("no_session"))
}

fn set_session_token(token: Option<String>) -> Result<(), String> {
    *SESSION_TOKEN.lock().map_err(|_| err("session_state"))? = token;
    Ok(())
}

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
    let resource_dir = app.path().resource_dir().map_err(|e| err_arg("resource_dir", e))?;

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
        Err(err_arg("binary_missing", format!("{name} ({path:?})")))
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
    adb_with_input(adb_path, args, None)
}

/// `input` goes to the child's stdin, which is the only way to get a secret onto
/// the phone without it appearing in a process argument list anyone can read.
fn adb_with_input(
    adb_path: &std::path::Path,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<String, String> {
    use std::io::Read;
    use std::time::{Duration, Instant};

    let mut child = hide_console(Command::new(adb_path))
        .args(args)
        .stdin(if input.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| err_arg("adb_exec", format!("{adb_path:?}: {e}")))?;

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

    if let Some(bytes) = input {
        let written = child.stdin.take().unwrap().write_all(bytes);
        if let Err(e) = written {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err_arg("adb_input", e));
        }
    }

    let timeout_secs = 15;
    let timeout = Duration::from_secs(timeout_secs);
    let start = Instant::now();
    let status;

    loop {
        if let Some(s) = child.try_wait().map_err(|e| err_arg("adb_wait", e))? {
            status = s;
            break;
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err_arg("adb_timeout", timeout_secs));
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
            return Err(err("no_usb_device"));
        }
        if combined.contains("unauthorized") {
            return Err(err("adb_unauthorized"));
        }
        return Err(err_arg("adb_failed", format!("{} (exit {}): {}", args.join(" "), status.code().unwrap_or(-1), stderr.trim())));
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
    daemon_command_with_token(cmd, &session_token()?)
}

/// One command per connection, framed the way the daemon will accept it. A path
/// carrying a line break would otherwise become a second command, so it is
/// refused here with a message that says what is wrong with it.
fn command_payload(cmd: &str, token: &str) -> Result<String, String> {
    // The bound is the daemon's own: its reader refuses any command line that
    // reaches 16 KiB, so a payload we are allowed to build must stay under it.
    if cmd.is_empty() || cmd.len() >= 16 * 1024 || cmd.contains(['\r', '\n', '\0']) {
        return Err(err("cmd_unsafe"));
    }
    Ok(format!("AUTH {token}\n{cmd}\n"))
}

fn daemon_command_with_token(cmd: &str, token: &str) -> Result<String, String> {
    let payload = command_payload(cmd, token)?;
    let started = std::time::Instant::now();
    let mut stream = TcpStream::connect_timeout(
        &DAEMON_ADDR.parse().unwrap(),
        TCP_CONNECT_TIMEOUT,
    )
    .map_err(|e| err_arg("daemon_connect", e))?;
    let connected = started.elapsed();

    stream
        .set_read_timeout(Some(TCP_READ_TIMEOUT))
        .map_err(|e| err_arg("daemon_timeout", e))?;
    stream
        .set_write_timeout(Some(TCP_CONNECT_TIMEOUT))
        .map_err(|e| err_arg("daemon_timeout", e))?;
    stream
        .write_all(payload.as_bytes())
        .map_err(|e| err_arg("daemon_send", e))?;
    let sent = started.elapsed();

    let mut response_bytes = Vec::with_capacity(1024 * 1024);
    stream
        .read_to_end(&mut response_bytes)
        .map_err(|e| err_arg("daemon_read", e))?;
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

    // Lossy decoding would silently rewrite any name the phone refuses to
    // encode — and the rewritten name is what a later delete would be handed.
    let response = String::from_utf8(plain)
        .map_err(|_| err("daemon_utf8"))?
        .trim()
        .to_string();
    let decoded = started.elapsed();

    // A daemon that dies mid-answer can leave *nothing* behind, and an empty
    // string is not a reply — treating it as one made the front end trip over
    // `JSON.parse` while the tunnel looked healthy.
    if !response.starts_with('{') || !response.ends_with('}') {
        return Err(err_arg("daemon_short", wire));
    }

    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    note_stage(
        wire,
        response.len(),
        ms(connected),
        ms(sent - connected),
        ms(read - sent),
        ms(unzipped - read),
        ms(decoded - unzipped),
    );
    Ok(response)
}

/// The shape every daemon answer is checked against before a caller sees it.
#[derive(serde::Deserialize)]
struct DaemonStatus {
    status: String,
    message: Option<String>,
    protocol_version: Option<u32>,
}

fn require_ok(response: &str) -> Result<DaemonStatus, String> {
    // Deliberately not the whole scan: the tree is tens of megabytes and nobody
    // needs a second copy of it just to read one field off the front.
    let parsed: DaemonStatus =
        serde_json::from_str(response).map_err(|_| err("daemon_bad_response"))?;
    if parsed.status != "ok" {
        return Err(err_arg("daemon_refused", parsed.message.unwrap_or_default()));
    }
    Ok(parsed)
}

/// 32 random bytes as 64 lowercase hex characters — the shape the daemon itself
/// validates before it will serve a connection.
fn new_session_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| err_arg("token_failed", e))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
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
    let _operation = DAEMON_OPERATION.lock().map_err(|_| err("daemon_state"))?;
    set_session_token(None)?;
    if let Ok(mut root) = SCAN_ROOT.lock() {
        *root = None;
    }
    let result = init_daemon_inner(app.clone(), serial);
    if result.is_err() {
        // A half-finished handshake must not leave a live daemon, a stale
        // forward or a secret file behind on the phone.
        let has_device = DEVICE_SERIAL.lock().map(|g| g.is_some()).unwrap_or(false);
        if has_device {
            if let Ok(adb_path) = get_bundled_binary(&app, "adb") {
                let _ = adb_s(&adb_path, &["shell", "pkill -f '[s]ocketsweep_daemon' || true"]);
                let _ = adb_s(&adb_path, &["forward", "--remove", &format!("tcp:{DAEMON_PORT}")]);
                let _ = adb_s(&adb_path, &["shell", "rm", "-f", DEVICE_TOKEN_PATH]);
            }
        }
        if let Ok(mut guard) = DEVICE_SERIAL.lock() {
            *guard = None;
        }
    }
    result
}

fn init_daemon_inner(app: tauri::AppHandle, serial: Option<String>) -> Result<String, String> {
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
                    return Err(err("adb_unauthorized"));
                }
                return Err(err("no_usb_device"));
            }
        },
    };

    // Store the serial so all subsequent ADB calls (including stop_daemon) target this device.
    if let Ok(mut guard) = DEVICE_SERIAL.lock() {
        *guard = Some(serial.clone());
    }

    // 2 — Kill any zombie daemon before we push/start.
    let _ = adb_s(&adb_path, &["shell", "pkill -f '[s]ocketsweep_daemon' || true"]);

    // 2.4 — Hand over a fresh secret. It goes in through stdin into a file only
    // the shell user can read, so it appears in no command line and never in the
    // JSON the front end is given.
    let token = new_session_token()?;
    let _ = adb_s(&adb_path, &["shell", "rm", "-f", DEVICE_TOKEN_PATH]);
    let token_cmd = format!("umask 077 && cat > {DEVICE_TOKEN_PATH}");
    let secret = format!("{token}\n");
    let target = device_serial();
    let mut args: Vec<&str> = Vec::new();
    if let Some(ref name) = target {
        args.extend(["-s", name.as_str()]);
    }
    args.extend(["shell", &token_cmd]);
    adb_with_input(&adb_path, &args, Some(secret.as_bytes()))?;

    // 2.5 — Automate MANAGE_EXTERNAL_STORAGE permission for the shell user.
    let _ = adb_s(&adb_path, &["shell", "appops set com.android.shell MANAGE_EXTERNAL_STORAGE allow"]);

    // 4 — Push binary to device.
    adb_s(&adb_path, &["push", &daemon_src.to_string_lossy(), DEVICE_BIN_PATH])?;

    // 5 — Make it executable.
    adb_s(&adb_path, &["shell", "chmod", "+x", DEVICE_BIN_PATH])?;

    // 5 — Kill any previously running instance (ignore errors).
    let _ = adb_s(&adb_path, &["shell", "pkill", "-f", "'[s]ocketsweep_daemon'"]);
    std::thread::sleep(Duration::from_millis(300));

    // 6 — Start the daemon in the background on the device. It takes the port
    // and the secret file, reads and unlinks the latter, and refuses any
    // connection that does not open with the matching AUTH line.
    let start_cmd = format!(
        "nohup {DEVICE_BIN_PATH} {DAEMON_PORT} {DEVICE_TOKEN_PATH} > /dev/null 2>&1 & echo $!; exit"
    );
    let pid_output = adb_s(&adb_path, &["shell", &start_cmd])?;
    let pid = pid_output.trim().to_string();

    // 7 — Set up the USB TCP tunnel.
    adb_s(&adb_path, &["forward", &format!("tcp:{DAEMON_PORT}"), &format!("tcp:{DAEMON_PORT}")])?;

    // 8 — Ping-Retry loop, on the new secret. A daemon too old to answer with
    // this protocol is treated as a failed start rather than accepted quietly:
    // it would be an unauthenticated one, still deleting anything asked.
    let mut pong = String::new();
    let mut connected_daemon = false;
    let mut wrong_daemon = None;
    for _ in 0..15 {
        std::thread::sleep(Duration::from_millis(150));
        match daemon_command_with_token("PING", &token) {
            Ok(res) => match require_ok(&res) {
                Ok(status) if status.protocol_version == Some(DAEMON_PROTOCOL) => {
                    pong = res;
                    connected_daemon = true;
                    break;
                }
                Ok(_) => wrong_daemon = Some(err("daemon_outdated")),
                Err(e) => wrong_daemon = Some(e),
            },
            Err(e) => wrong_daemon = Some(e),
        }
    }

    if !connected_daemon {
        return wrong_daemon.map_or_else(|| Err(err("daemon_no_ping")), Err);
    }

    // Only now does the session exist for everything else to use.
    set_session_token(Some(token))?;

    Ok(format!(
        "{{\"daemon_pid\":\"{pid}\",\"serial\":\"{serial}\",\"ping_response\":{pong}}}"
    ))
}

#[tauri::command(async)]
fn run_scan(app: tauri::AppHandle, path: Option<String>) -> Result<String, String> {
    let effective_root = match path {
        Some(ref p) if !p.is_empty() => p.clone(),
        _ => "/sdcard".to_string(), // daemon default
    };
    let cmd = format!("SCAN {effective_root}");

    // One automatic recovery per scan, for the two ways a scan dies without
    // saying so: the tunnel breaks mid-transfer (the answer comes back short or
    // corrupt), and the daemon being alive but blind — it answers instantly with
    // an empty tree when the shell user has lost storage access, which looks
    // exactly like a phone with nothing on it.
    //
    // Deliberately NOT holding DAEMON_OPERATION: the recovery below calls
    // init_daemon, which takes that lock itself, and the standard mutex is not
    // reentrant. The scan is the long-running command, so serialising it here
    // would also make a reconnect wait for a scan that is already going wrong.
    let mut attempts = 0;
    let answer = loop {
        attempts += 1;
        match daemon_command(&cmd) {
            Ok(answer) => {
                let blind = attempts == 1 && answer_is_blind(&answer) && phone_has_data(&app);
                if blind && revive_daemon(&app).is_ok() {
                    println!("[SCAN] empty answer on a phone that has data — restarted the daemon, scanning again");
                    continue;
                }
                break answer;
            }
            Err(e) => {
                if attempts == 1 && tunnel_broke(&e) && revive_daemon(&app).is_ok() {
                    println!("[SCAN] tunnel failed ({e}) — restarted the daemon, scanning again");
                    continue;
                }
                return Err(e);
            }
        }
    };

    // Store the scan root so delete_item can guard against it.
    if let Ok(mut root) = SCAN_ROOT.lock() {
        *root = Some(effective_root);
    }

    Ok(answer)
}

/// A well-formed scan that found nothing at all. Real phones with data on them
/// never produce this, so it means the daemon could not see the filesystem.
fn answer_is_blind(answer: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(answer)
        .map(|v| v["status"] == "ok" && v["total_files"].as_i64() == Some(0))
        .unwrap_or(false)
}

/// Whether an error means the tunnel or the daemon died rather than the phone
/// genuinely refusing the command.
fn tunnel_broke(error: &str) -> bool {
    [
        "E#daemon_connect",
        "E#daemon_send",
        "E#daemon_read",
        "E#daemon_timeout",
        "E#daemon_short",
        "E#inflate_failed",
    ]
    .iter()
    .any(|code| error.starts_with(code))
}

/// Does the volume hold anything? Only used to decide whether an empty scan is
/// worth retrying, so a failing `df` answers "no" and leaves the first result up.
fn phone_has_data(app: &tauri::AppHandle) -> bool {
    get_storage_info(app.clone())
        .ok()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
        .and_then(|v| v["used_bytes"].as_i64())
        .unwrap_or(0)
        > 512 * 1024 * 1024
}

/// Bring the daemon back from a dead tunnel or a blind start. This is the full
/// handshake rather than a bare `adb forward`: it kills the old instance — which
/// may still be sitting on a half-sent answer — re-applies the storage permission
/// grant, and re-pings before anything else is allowed to talk to it.
fn revive_daemon(app: &tauri::AppHandle) -> Result<(), String> {
    let adb_path = get_bundled_binary(app, "adb")?;
    let _ = adb_s(&adb_path, &["forward", "--remove", &format!("tcp:{DAEMON_PORT}")]);
    init_daemon(app.clone(), device_serial()).map(|_| ())
}

#[tauri::command(async)]
fn ping_daemon() -> Result<String, String> {
    daemon_command("PING")
}

#[tauri::command(async)]
fn stop_daemon(app: tauri::AppHandle) -> Result<String, String> {
    let _operation = DAEMON_OPERATION.lock().map_err(|_| err("daemon_state"))?;
    let adb_path = get_bundled_binary(&app, "adb")?;
    let response = daemon_command("SHUTDOWN")
        .unwrap_or_else(|_| "{\"status\":\"ok\",\"message\":\"already gone\"}".into());
    set_session_token(None)?;
    let _ = adb_s(&adb_path, &["forward", "--remove", &format!("tcp:{DAEMON_PORT}")]);
    let _ = adb_s(&adb_path, &["shell", "rm", "-f", DEVICE_BIN_PATH]);
    let _ = adb_s(&adb_path, &["shell", "rm", "-f", DEVICE_TOKEN_PATH]);
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
        .ok_or_else(|| err("df_empty"))?;

    let cols: Vec<&str> = row.split_whitespace().collect();
    if cols.len() < 4 {
        return Err(err_arg("storage_df", format!("unparsable row '{row}'")));
    }
    if !header_kb {
        return Err(err_arg("storage_df", format!("df did not report 1K blocks ({row})")));
    }

    let parse_kb = |v: &str| -> Result<i64, String> {
        v.parse::<i64>()
            .map(|kb| kb * 1024)
            .map_err(|e| err_arg("storage_df", format!("bad value '{v}' ({e})")))
    };

    Ok(format!(
        "{{\"total_bytes\":{},\"used_bytes\":{},\"free_bytes\":{}}}",
        parse_kb(cols[1])?,
        parse_kb(cols[2])?,
        parse_kb(cols[3])?,
    ))
}

#[tauri::command(async)]
fn delete_item(path: String) -> Result<String, String> {
    // Prevent deletion of the scan root directory.
    if let Ok(root) = SCAN_ROOT.lock() {
        if let Some(ref scan_root) = *root {
            if path == *scan_root {
                return Err(err("delete_scan_root"));
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
fn peek_file(app: tauri::AppHandle, device_path: String, limit: u32, offset: u32) -> Result<String, String> {
    if !device_path.starts_with("/sdcard") {
        return Err(err("peek_outside_sdcard"));
    }
    let adb_path = get_bundled_binary(&app, "adb")?;
    // 2 MB ceiling: enough for the front end to take a whole PNG when it carries
    // no EXIF preview, and far short of pulling a real photo across adb.
    //
    // `offset` makes this a byte-range read, because an APK's index sits at the
    // *end* of the file. `dd` only seeks in whole blocks, so the read starts at
    // the block below the wanted byte and the remainder is cut off afterwards.
    //
    // The block budget is one block larger than the byte ceiling for exactly
    // that reason: without it, a request of a full 2 MB at an unaligned offset
    // would come back a few hundred bytes short of the end of the file, and a
    // truncated tail is precisely the part a zip index ends with.
    let head = offset % 1024;
    let skip = offset / 1024;
    let blocks = ((head + limit + 1023) / 1024).clamp(1, 2049);
    let command = format!(
        "dd if={} bs=1024 skip={} count={} 2>/dev/null",
        shell_quote(&device_path), skip, blocks
    );
    let wanted = limit.min(blocks * 1024 - head);

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
    let from = (head as usize).min(output.stdout.len());
    let to = (from + wanted as usize).min(output.stdout.len());
    Ok(base64(&output.stdout[from..to]))
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
    serde_json::to_string(&out).map_err(|e| err_arg("encode_failed", e))
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

    serde_json::to_string(&groups).map_err(|e| err_arg("encode_failed", e))
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
static THUMB_PATH: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);
static CLEAR_CACHE_ON_EXIT: AtomicBool = AtomicBool::new(false);

fn configured(slot: &Mutex<Option<std::path::PathBuf>>) -> Option<std::path::PathBuf> {
    slot.lock().ok().and_then(|guard| guard.clone())
}

/// The unconfigured home for all three folders: `data\` next to the installed
/// exe, so a copy of a phone file lands on the same drive as the program rather
/// than quietly filling the system drive. That only works where the install
/// folder is writable — an install under Program Files is not — so the choice is
/// made by a write probe, not by assumption. `SOCKETSWEEP_CACHE_DIR` lets a dev
/// build keep its scratch files somewhere else entirely.
fn default_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    if let Ok(custom) = std::env::var("SOCKETSWEEP_CACHE_DIR") {
        if !custom.is_empty() {
            return Ok(std::path::PathBuf::from(custom));
        }
    }
    if let Some(next_to_app) = std::env::current_exe().ok().and_then(|exe| {
        let dir = exe.parent()?.join("data");
        match std::fs::create_dir_all(&dir) {
            Ok(()) => Some(dir),
            Err(_) => None,
        }
    }) {
        return Ok(next_to_app);
    }
    app.path()
        .app_cache_dir()
        .map_err(|e| err_arg("folder_pick", e))
        .map(|dir| dir.join("socketsweep"))
}

fn ensure_dir(path: std::path::PathBuf, label: &str) -> Result<std::path::PathBuf, String> {
    std::fs::create_dir_all(&path)
        .map_err(|e| err_arg(&format!("dir_create_failed_{label}"), format!("{path:?} — {e}")))?;
    Ok(path)
}

/// Each of the three gets its own subfolder: "everything in here is ours" has to
/// stay true for the cache, which is the one that may be emptied on its own.
fn cache_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    match configured(&CACHE_PATH) {
        Some(path) => ensure_dir(path, "cache"),
        None => ensure_dir(default_root(app)?.join("cache"), "cache"),
    }
}

fn download_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    match configured(&DOWNLOAD_PATH) {
        Some(path) => ensure_dir(path, "download"),
        None => ensure_dir(default_root(app)?.join("downloads"), "download"),
    }
}

/// Previews live in their own folder so they can be thrown away on their own —
/// they are re-creatable, unlike a file the user asked to keep.
fn thumb_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    match configured(&THUMB_PATH) {
        Some(path) => ensure_dir(path, "thumbs"),
        None => ensure_dir(default_root(app)?.join("thumbs"), "thumbs"),
    }
}

#[derive(serde::Serialize)]
struct Paths {
    cache: String,
    download: String,
    thumb: String,
    cache_custom: bool,
    download_custom: bool,
    thumb_custom: bool,
    clear_on_exit: bool,
}

fn describe_paths(app: &tauri::AppHandle) -> Result<Paths, String> {
    Ok(Paths {
        cache: cache_dir(app)?.to_string_lossy().into_owned(),
        download: download_dir(app)?.to_string_lossy().into_owned(),
        thumb: thumb_dir(app)?.to_string_lossy().into_owned(),
        cache_custom: configured(&CACHE_PATH).is_some(),
        download_custom: configured(&DOWNLOAD_PATH).is_some(),
        thumb_custom: configured(&THUMB_PATH).is_some(),
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

/// Reads or updates the three folders and the exit switch in one round trip; the
/// UI sends only the fields it is changing and always gets the full state back.
#[tauri::command(async)]
fn set_paths(
    app: tauri::AppHandle,
    cache: Option<String>,
    download: Option<String>,
    thumbs: Option<String>,
    clear_on_exit: Option<bool>,
) -> Result<String, String> {
    pick(&CACHE_PATH, cache, "cache", true)?;
    pick(&DOWNLOAD_PATH, download, "download", false)?;
    // Previews are disposable, so the folder they live in has to be ours alone.
    pick(&THUMB_PATH, thumbs, "thumbs", true)?;
    if let Some(flag) = clear_on_exit {
        CLEAR_CACHE_ON_EXIT.store(flag, Ordering::Relaxed);
    }
    let state = serde_json::to_string(&describe_paths(&app)?).map_err(|e| err_arg("encode_failed", e))?;
    Ok(state)
}

/// Which of the three folders a command should act on.
fn dir_for(app: &tauri::AppHandle, kind: &str) -> Result<std::path::PathBuf, String> {
    match kind {
        "download" => download_dir(app),
        "thumbs" => thumb_dir(app),
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
    serde_json::to_string(&out).map_err(|e| err_arg("encode_failed", e))
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

// ── Thumbnail cache ─────────────────────────────────────────────────────────

/// A preview is kept as the exact `data:` URL the row renders, so reading it
/// back needs no decoding or re-encoding. The key is built by the front end from
/// the phone path plus the file's size and modification time, so a photo that
/// changed on the phone is a different key — a stale picture can never be shown
/// as if it were current.
fn thumb_file(dir: &std::path::Path, key: &str) -> Result<std::path::PathBuf, String> {
    let safe = !key.is_empty()
        && key.len() <= 96
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.');
    if !safe {
        return Err(err("thumb_key_bad"));
    }
    Ok(dir.join(key))
}

/// The stored text, or empty when there is no entry. `none` is a real answer:
/// it records that this file has no preview to be had, so the phone is not
/// asked again on every visit.
#[tauri::command(async)]
fn thumb_get(app: tauri::AppHandle, key: String) -> Result<String, String> {
    let path = thumb_file(&thumb_dir(&app)?, &key)?;
    Ok(std::fs::read_to_string(&path).unwrap_or_default())
}

#[tauri::command(async)]
fn thumb_put(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let path = thumb_file(&thumb_dir(&app)?, &key)?;
    std::fs::write(&path, value.as_bytes()).map_err(|e| err_arg("thumb_write_failed", e))
}

/// Drops the oldest previews until the folder fits, or empties it with `all`.
#[tauri::command(async)]
fn trim_thumb_cache(app: tauri::AppHandle, limit_bytes: i64, all: bool) -> Result<String, String> {
    let mut ours = dir_entries(&thumb_dir(&app)?);
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
    Ok(serde_json::json!({ "removed": removed, "freed": freed, "bytes": total }).to_string())
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
        .ok_or_else(|| err_arg("path_not_text", local.display()))?
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
            .map_err(|e| err_arg("pull_start_failed", e))?;

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
        .ok_or_else(|| err_arg("path_not_text", dir.display()))?
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
    serde_json::to_string(&result).map_err(|e| err_arg("encode_failed", e))
}

// ── Tauri entry point ───────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// ── Window geometry ─────────────────────────────────────────────────────────

#[derive(serde::Deserialize, serde::Serialize, Default, Clone, Copy)]
struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

fn geometry_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| err_arg("folder_pick", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| err_arg("folder_pick", e))?;
    Ok(dir.join("window.json"))
}

/// Brings back the last size and place — but only where a screen actually is.
/// A monitor that has been unplugged would otherwise leave the window sitting
/// somewhere unreachable, which reads to the user as "the app won't open".
fn restore_geometry(app: &tauri::AppHandle) {
    let Ok(path) = geometry_file(app) else { return };
    let Ok(text) = std::fs::read_to_string(path) else { return };
    let Ok(saved) = serde_json::from_str::<Geometry>(&text) else { return };
    if saved.width < 320 || saved.height < 240 {
        return;
    }

    let handle = app.clone();
    std::thread::spawn(move || {
        // The window described in tauri.conf.json is not necessarily built by
        // the time the setup hook runs, so wait for it instead of assuming an
        // order — and take whatever the one window is called.
        for _ in 0..120 {
            let window = handle
                .get_webview_window("main")
                .or_else(|| handle.webview_windows().into_values().next());
            let Some(window) = window else {
                std::thread::sleep(Duration::from_millis(25));
                continue;
            };

            let visible = handle
                .available_monitors()
                .unwrap_or_default()
                .iter()
                .any(|m| {
                    let (mx, my) = (m.position().x, m.position().y);
                    let (mw, mh) = (m.size().width as i32, m.size().height as i32);
                    saved.x + 80 > mx && saved.x < mx + mw && saved.y + 40 > my && saved.y < my + mh
                });

            let _ = window.set_size(tauri::PhysicalSize::new(saved.width, saved.height));
            if visible {
                let _ = window.set_position(tauri::PhysicalPosition::new(saved.x, saved.y));
            }
            if saved.maximized {
                let _ = window.maximize();
            }
            return;
        }
    });
}

fn save_geometry(app: &tauri::AppHandle, label: &str) {
    // By the time the loop reports Exit the window is already gone, so this has
    // to run while it still exists — CloseRequested is that moment.
    let Some(window) = app.get_webview_window(label) else { return };
    let Ok(position) = window.outer_position() else { return };
    let Ok(size) = window.outer_size() else { return };
    let saved = Geometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().unwrap_or(false),
    };
    if let (Ok(path), Ok(text)) = (geometry_file(app), serde_json::to_string(&saved)) {
        let _ = std::fs::write(path, text);
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            restore_geometry(&app.handle().clone());
            Ok(())
        })
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
            thumb_get,
            thumb_put,
            trim_thumb_cache,
            pull_file,
            cancel_transfer,
            reveal_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { .. }, .. } => {
                    save_geometry(app, label.as_str());
                }
                tauri::RunEvent::Exit => {
                    // Emptying the cache on exit only happens because the settings
                    // page asked for it; downloads and previews are never touched.
                    if CLEAR_CACHE_ON_EXIT.load(Ordering::Relaxed) {
                        let _ = clear_cache(app, 0, true);
                    }
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    // The daemon's reader treats a line as complete only at '\n', and refuses
    // '\r', '\0' and anything 16 KiB or longer. A payload that slipped past the
    // checks here would be rejected on the phone as "Invalid command framing",
    // which the user cannot act on — so the local refusal has to be the stricter
    // of the two.
    #[test]
    fn payload_opens_with_the_session_secret() {
        let payload = command_payload("PING", "a").unwrap();
        assert_eq!(payload, "AUTH a\nPING\n");
    }

    #[test]
    fn payload_refuses_lines_that_are_not_one_command() {
        for cmd in ["", "PING\nSHUTDOWN", "DELETE \r/sdcard/a", "DELETE /sdcard/a\0b"] {
            assert_eq!(
                command_payload(cmd, "tok"),
                Err(err("cmd_unsafe")),
                "accepted a command that is not a single safe line: {cmd:?}"
            );
        }
    }

    #[test]
    fn payload_refuses_what_the_daemon_would_refuse() {
        let just_under = "x".repeat(16 * 1024 - 1);
        assert!(command_payload(&just_under, "tok").is_ok());
        for too_long in ["x".repeat(16 * 1024), "x".repeat(16 * 1024 + 1)] {
            assert_eq!(command_payload(&too_long, "tok"), Err(err("cmd_unsafe")));
        }
    }

    #[test]
    fn session_secret_is_the_shape_the_daemon_validates() {
        let token = new_session_token().unwrap();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        assert_ne!(token, new_session_token().unwrap());
    }

    #[test]
    fn declared_protocol_matches_the_bundled_daemon() {
        // engine/daemon.cpp answers PING with this number; if the two drift
        // apart, every connection fails with "daemon_outdated" on a real phone,
        // which is exactly the kind of break a text search should not have to
        // discover by hand. The daemon writes the field inside an escaped C++
        // string literal, so the digit is found by scanning forward from the
        // name rather than by matching `"protocol_version":N`.
        let source = include_str!("../../engine/daemon.cpp");
        let at = source
            .find("protocol_version")
            .expect("the daemon does not answer PING with a protocol_version");
        let announced = source[at..]
            .chars()
            .find(|c| c.is_ascii_digit())
            .and_then(|c| c.to_digit(10))
            .expect("no protocol_version number in the daemon source");
        assert_eq!(u32::try_from(announced).ok(), Some(DAEMON_PROTOCOL));
    }
}
