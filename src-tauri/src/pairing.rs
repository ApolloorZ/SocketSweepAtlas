// Wireless pairing driven by a QR code the phone scans.
//
// The phone's "pair with QR code" screen accepts `WIFI:T:ADB;S:<name>;P:<password>;;`.
// After scanning it advertises an `_adb-tls-pairing._tcp` mDNS service under that
// same name, carrying its real address and pairing port — so we can discover it
// with `adb mdns services` and then run the ordinary `adb pair` / `adb connect`.
// No handshake code of our own is involved.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use rand::Rng;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const PAIR_SERVICE: &str = "_adb-tls-pairing";
const CONNECT_SERVICE: &str = "_adb-tls-connect";
const SCAN_TIMEOUT: Duration = Duration::from_secs(300);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long to hold out for the instance name from the QR before trusting a
/// single pairing service on the network.
const SOLO_FALLBACK: Duration = Duration::from_secs(12);
/// How long the hands-off LAN search runs before we ask the user to intervene.
const DISCOVER_TIMEOUT: Duration = Duration::from_secs(10);

static SESSION_ID: AtomicU64 = AtomicU64::new(0);
static CANCELLED: AtomicBool = AtomicBool::new(false);

fn random_from(alphabet: &[u8], len: usize) -> String {
    let mut rng = rand::rng();
    (0..len)
        .map(|_| alphabet[rng.random_range(0..alphabet.len())] as char)
        .collect()
}

#[derive(Clone, Serialize)]
struct Progress {
    state: String,
    message: String,
    serial: Option<String>,
}

fn report(app: &AppHandle, state: &str, message: String, serial: Option<String>) {
    let _ = app.emit(
        "pair-progress",
        Progress { state: state.into(), message, serial },
    );
}

/// Renders a QR code as an SVG string so the WebView needs no image pipeline.
fn qr_svg(text: &str) -> Result<String, String> {
    use qrcode::{Color, EcLevel, QrCode};

    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M)
        .map_err(|e| format!("无法生成二维码: {e}"))?;
    let width = code.width();
    let colors = code.to_colors();
    let quiet = 4usize;
    let side = width + quiet * 2;

    let mut path = String::new();
    for (i, color) in colors.iter().enumerate() {
        if *color != Color::Dark {
            continue;
        }
        let x = i % width + quiet;
        let y = i / width + quiet;
        path.push_str(&format!("M{x} {y}h1v1h-1z"));
    }

    Ok(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {side} {side}\" shape-rendering=\"crispEdges\">\
         <rect width=\"{side}\" height=\"{side}\" fill=\"#ffffff\"/>\
         <path d=\"{path}\" fill=\"#0f0f11\"/></svg>"
    ))
}

#[derive(Clone)]
struct MdnsRow {
    instance: String,
    service: String,
    address: String,
    port: u16,
}

/// Parses `adb mdns services` into rows. adb prints either tab or space aligned
/// columns depending on version, so accept both.
fn mdns_services(adb_path: &std::path::Path) -> Vec<MdnsRow> {
    let output = match crate::adb(adb_path, &["mdns", "services"]) {
        Ok(out) => out,
        Err(_) => return Vec::new(),
    };

    let mut rows = Vec::new();
    for line in output.lines() {
        let parts: Vec<&str> = if line.contains('\t') {
            line.split('\t').map(|s| s.trim()).collect()
        } else {
            line.split_whitespace().collect()
        };
        if parts.len() < 3 {
            continue;
        }
        let service = match parts.iter().position(|p| p.starts_with("_adb-tls-")) {
            Some(index) => parts[index].to_string(),
            None => continue,
        };
        let Some(endpoint) = parts.iter().rev().find(|p| p.contains(':') && p.contains('.')) else {
            continue;
        };
        let Some((address, raw_port)) = endpoint.rsplit_once(':') else {
            continue;
        };
        let Ok(port) = raw_port.parse::<u16>() else {
            continue;
        };

        rows.push(MdnsRow {
            instance: parts[0].to_string(),
            service,
            address: address.to_string(),
            port,
        });
    }
    rows
}

/// Waits for the phone to show up in `adb mdns services` after it was scanned.
///
/// `solo_fallback` relaxes the match once that long has passed: some vendor ROMs
/// advertise under their own instance name instead of the one we put in the QR,
/// and a lone pairing service on the LAN can only be our scanner.
fn wait_for_service(
    adb_path: &std::path::Path,
    prefix: &str,
    accept: &dyn Fn(&MdnsRow) -> bool,
    timeout: Duration,
    solo_fallback: Option<Duration>,
    timeout_message: &str,
) -> Result<MdnsRow, String> {
    let started = Instant::now();
    loop {
        if CANCELLED.load(Ordering::Relaxed) {
            return Err("已取消。".into());
        }

        let rows: Vec<MdnsRow> = mdns_services(adb_path)
            .into_iter()
            .filter(|r| r.service.starts_with(prefix))
            .collect();

        if let Some(hit) = rows.iter().find(|r| accept(r)) {
            return Ok(hit.clone());
        }
        if rows.len() == 1 && solo_fallback.is_some_and(|delay| started.elapsed() >= delay) {
            return Ok(rows[0].clone());
        }
        if started.elapsed() >= timeout {
            return Err(timeout_message.into());
        }

        thread::sleep(Duration::from_millis(1000));
    }
}

fn mdns_ready(check_output: &str) -> bool {
    check_output.to_lowercase().contains("daemon version")
}

/// adb's mDNS browser only runs if the server was started with it enabled; if a
/// stale server is running without it, restart the server once and re-check.
fn ensure_mdns(adb_path: &std::path::Path) -> Result<(), String> {
    if let Ok(out) = crate::adb(adb_path, &["mdns", "check"]) {
        if mdns_ready(&out) {
            return Ok(());
        }
    }
    let _ = crate::adb(adb_path, &["kill-server"]);
    thread::sleep(Duration::from_millis(800));
    let retried = crate::adb(adb_path, &["mdns", "check"]).unwrap_or_default();
    if mdns_ready(&retried) {
        Ok(())
    } else {
        Err("这台电脑上的 adb 不支持局域网发现,请更新 platform-tools 后再试。".into())
    }
}

/// adb reports a wireless device either as `ip:port` or, once it has resolved it
/// through mDNS itself, under a long `_adb-tls-connect` transport name.
pub(crate) fn is_wireless_serial(serial: &str) -> bool {
    serial.contains(':') || serial.contains("_adb-tls-")
}

/// Serials adb currently considers usable.
fn connected_serials(adb_path: &std::path::Path) -> Vec<String> {
    let output = crate::adb(adb_path, &["devices"]).unwrap_or_default();
    output
        .lines()
        .skip(1)
        .filter_map(|line| {
            let mut cols = line.split_whitespace();
            match (cols.next(), cols.next()) {
                (Some(serial), Some("device")) => Some(serial.to_string()),
                _ => None,
            }
        })
        .collect()
}

/// Dials `ip:port` and waits until that transport really shows up as usable.
fn dial(adb_path: &std::path::Path, target: &str) -> bool {
    // "unable to connect" is normal while the device is still settling; the
    // device list below is the only verdict we trust.
    let _ = crate::adb(adb_path, &["connect", target]);
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        if connected_serials(adb_path).iter().any(|s| s == target) {
            return true;
        }
        thread::sleep(Duration::from_millis(500));
    }
    false
}

/// Turns a finished pairing into a live connection.
///
/// Right after `adb pair` succeeds adb usually connects the device on its own and
/// drops the `_adb-tls-connect` advertisement it had published, so watching for a
/// new transport comes first; dialling the advertised port is only the fallback.
fn finish_connection(
    adb_path: &std::path::Path,
    before: &[String],
    address: &str,
    active: &dyn Fn() -> bool,
) -> Result<String, String> {
    let started = Instant::now();
    while started.elapsed() < CONNECT_TIMEOUT {
        if !active() {
            return Err("已取消。".into());
        }

        if let Some(serial) = connected_serials(adb_path)
            .into_iter()
            .find(|s| !before.contains(s))
        {
            return Ok(serial);
        }

        // Re-pairing a phone that is already connected yields no new transport at
        // all, so after a short grace the existing wireless one counts as success.
        if started.elapsed() > Duration::from_secs(4) {
            if let Some(serial) = connected_serials(adb_path)
                .into_iter()
                .find(|s| is_wireless_serial(s))
            {
                return Ok(serial);
            }
        }

        if let Some(row) = mdns_services(adb_path)
            .into_iter()
            .find(|r| r.service.starts_with(CONNECT_SERVICE) && r.address == address)
        {
            let target = format!("{}:{}", row.address, row.port);
            if dial(adb_path, &target) {
                return Ok(target);
            }
        }

        thread::sleep(Duration::from_millis(1000));
    }

    let legacy = format!("{address}:5555");
    if dial(adb_path, &legacy) {
        return Ok(legacy);
    }
    Err("配对成功了,但连接没建起来。请在手机上把「无线调试」关掉再打开一次,然后到设备列表里点「一键连接」。".into())
}

#[derive(Clone, Serialize)]
pub struct AutoResult {
    /// "connected" — a wireless transport is live; "needs-pairing" — the UI has to
    /// prove physical presence, which Android requires before any pairing.
    pub status: String,
    pub serial: Option<String>,
    /// Pairing endpoint adb overheard on the LAN, i.e. the phone is sitting on its
    /// "pair with pairing code" screen and only the 6 digits are missing.
    pub pairing_endpoint: Option<String>,
}

/// The zero-typing wireless path: reuse a live transport, otherwise dial whatever
/// the phone advertises. Only when neither works do we need the user to act.
pub fn auto_connect(adb_path: &std::path::Path) -> Result<AutoResult, String> {
    if let Some(serial) = connected_serials(adb_path)
        .into_iter()
        .find(|s| is_wireless_serial(s))
    {
        return Ok(AutoResult { status: "connected".into(), serial: Some(serial), pairing_endpoint: None });
    }

    ensure_mdns(adb_path)?;

    let started = Instant::now();
    while started.elapsed() < DISCOVER_TIMEOUT {
        for row in mdns_services(adb_path)
            .into_iter()
            .filter(|r| r.service.starts_with(CONNECT_SERVICE))
        {
            let target = format!("{}:{}", row.address, row.port);
            if dial(adb_path, &target) {
                return Ok(AutoResult { status: "connected".into(), serial: Some(target), pairing_endpoint: None });
            }
        }
        thread::sleep(Duration::from_millis(700));
    }

    let pairing_endpoint = mdns_services(adb_path)
        .into_iter()
        .find(|r| r.service.starts_with(PAIR_SERVICE))
        .map(|r| format!("{}:{}", r.address, r.port));

    Ok(AutoResult { status: "needs-pairing".into(), serial: None, pairing_endpoint })
}

pub fn start(app: AppHandle) -> Result<(String, String), String> {
    let name = format!("socketsweep-{}", random_from(b"0123456789abcdef", 8));
    let password = random_from(
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
        12,
    );
    let qr_text = format!("WIFI:T:ADB;S:{name};P:{password};;");
    let svg = qr_svg(&qr_text)?;

    let session = SESSION_ID.fetch_add(1, Ordering::SeqCst) + 1;
    CANCELLED.store(false, Ordering::Relaxed);

    thread::spawn(move || {
        let active = || SESSION_ID.load(Ordering::SeqCst) == session && !CANCELLED.load(Ordering::Relaxed);

        let adb_path = match crate::get_bundled_binary(&app, "adb") {
            Ok(path) => path,
            Err(_) => {
                report(&app, "error", "找不到自带的 adb,无法完成配对。".into(), None);
                return;
            }
        };

        if let Err(message) = ensure_mdns(&adb_path) {
            report(&app, "error", message, None);
            return;
        }
        if !active() {
            return;
        }

        report(&app, "waiting", "等待手机扫码…".into(), None);
        let paired = wait_for_service(
            &adb_path,
            PAIR_SERVICE,
            &|row| row.instance == name,
            SCAN_TIMEOUT,
            Some(SOLO_FALLBACK),
            "等了五分钟没等到扫码。请确认手机停在「使用二维码配对设备」界面,并且和电脑连着同一个 Wi-Fi。",
        );

        if !active() {
            return;
        }
        let device = match paired {
            Ok(row) => row,
            Err(message) => {
                report(&app, "error", message, None);
                return;
            }
        };

        report(
            &app,
            "found",
            format!("发现手机 {},正在配对…", device.address),
            None,
        );

        let pair_target = format!("{}:{}", device.address, device.port);
        let before = connected_serials(&adb_path);
        if let Err(err) = crate::adb(&adb_path, &["pair", &pair_target, &password]) {
            report(&app, "error", format!("配对失败:{err}"), None);
            return;
        }
        if !active() {
            return;
        }

        report(&app, "pairing", "配对成功,正在建立连接…".into(), None);
        match finish_connection(&adb_path, &before, &device.address, &active) {
            Ok(serial) => report(&app, "connected", format!("已连接 {serial}"), Some(serial)),
            Err(message) => report(&app, "error", message, None),
        }
    });

    Ok((svg, qr_text))
}

pub fn cancel() {
    SESSION_ID.fetch_add(1, Ordering::SeqCst);
    CANCELLED.store(true, Ordering::Relaxed);
}