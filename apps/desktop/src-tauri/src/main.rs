#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod lifecycle;
mod recovery;
mod workspace;

use serde::Deserialize;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    env,
    io::{BufRead, BufReader, Read},
    path::Path,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::ShellExt;
use url::Url;

const MAX_READY_BYTES: u64 = 4096;
const READY_TIMEOUT: Duration = Duration::from_secs(45);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadyEnvelope {
    ok: bool,
    data: ReadyData,
    error: serde_json::Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadyData {
    url: String,
    owner: String,
}

fn validated_url(raw: &str) -> Result<Url, &'static str> {
    let url = Url::parse(raw).map_err(|_| "invalid host handshake")?;
    let secret = url.fragment().and_then(|f| f.strip_prefix("launch="));
    if !raw.starts_with("http://127.0.0.1:")
        || url.as_str() != raw
        || url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none_or(|port| port == 0)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || !secret.is_some_and(|s| {
            s.len() == 64
                && s.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    {
        return Err("invalid host handshake");
    }
    Ok(url)
}

fn read_ready(stdout: std::process::ChildStdout) -> Result<(Url, String), &'static str> {
    let (tx, rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut line = Vec::new();
        let result = BufReader::new(stdout)
            .take(MAX_READY_BYTES + 1)
            .read_until(b'\n', &mut line)
            .map_err(|_| "host handshake unavailable")
            .and_then(|n| parse_ready(&line, n as u64));
        let _ = tx.send(result);
    });
    rx.recv_timeout(READY_TIMEOUT)
        .map_err(|_| "host startup timed out")?
}

fn parse_ready(line: &[u8], count: u64) -> Result<(Url, String), &'static str> {
    if count == 0 || count > MAX_READY_BYTES || line.last() != Some(&b'\n') {
        return Err("invalid host handshake");
    }
    let body = line.strip_suffix(b"\n").unwrap_or(line);
    let envelope: ReadyEnvelope =
        serde_json::from_slice(body).map_err(|_| "invalid host handshake")?;
    if !envelope.ok || !envelope.error.is_null() {
        return Err("host startup failed");
    }
    let owner = envelope.data.owner;
    if owner.len() != 36
        || !owner.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
    {
        return Err("invalid host handshake");
    }
    Ok((validated_url(&envelope.data.url)?, owner))
}

struct OwnedHost {
    child: Child,
    owner: String,
}

fn launch_host(
    app: &tauri::AppHandle,
    root: &Path,
) -> Result<(OwnedHost, Url), Box<dyn std::error::Error>> {
    let hearth: Command = app.shell().sidecar("hearth")?.into();
    let hearth = hearth.get_program().to_owned();
    let assets = app.path().resource_dir()?.join("dashboard");
    let mut host: Command = app.shell().sidecar("desktop-host")?.into();
    let command = host
        .args([
            "--root",
            root.to_str().ok_or("invalid checkout root")?,
            "--assets",
        ])
        .arg(assets)
        .arg("--hearth")
        .arg(hearth)
        .env("NO_PROXY", proxy_bypass_env())
        .env("no_proxy", proxy_bypass_env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().ok_or("host output unavailable")?;
    match read_ready(stdout) {
        Ok((url, owner)) => Ok((OwnedHost { child, owner }, url)),
        Err(error) => {
            stop_child(&mut child);
            Err(error.into())
        }
    }
}

fn proxy_bypass_env() -> String {
    let upper = env::var("NO_PROXY").unwrap_or_default();
    let lower = env::var("no_proxy").unwrap_or_default();
    proxy_bypass(&upper, &lower)
}

fn proxy_bypass(upper: &str, lower: &str) -> String {
    let mut entries = Vec::new();
    for value in [upper, lower] {
        for entry in value.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            if !entries.iter().any(|seen| seen == entry) {
                entries.push(entry.to_owned());
            }
        }
    }
    if !entries.iter().any(|entry| entry == "127.0.0.1") {
        entries.push("127.0.0.1".to_owned());
    }
    entries.join(",")
}

fn stop_child(child: &mut Child) {
    drop(child.stdin.take());
    let until = Instant::now() + SHUTDOWN_GRACE;
    while Instant::now() < until {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

struct HostProcess {
    process: Mutex<lifecycle::Lifecycle<OwnedHost>>,
    origin: Mutex<Option<url::Origin>>,
}
impl HostProcess {
    fn stopped(&self) -> bool {
        self.process.lock().map_or(true, |slot| slot.stopped())
    }

    fn shutdown(&self) {
        let child = self
            .process
            .lock()
            .ok()
            .and_then(|mut slot| slot.shutdown());
        if let Some(mut owned) = child {
            stop_child(&mut owned.child);
        }
    }
}
impl Drop for HostProcess {
    fn drop(&mut self) {
        if let Ok(slot) = self.process.get_mut() {
            if let Some(mut owned) = slot.shutdown() {
                stop_child(&mut owned.child);
            }
        }
    }
}

fn cleanup_owner(app: &tauri::AppHandle, root: &Path, owner: &str) -> bool {
    let Ok(command) = app.shell().sidecar("desktop-host") else {
        return false;
    };
    let mut command: Command = command.into();
    command
        .arg("--cleanup")
        .arg("--root")
        .arg(root)
        .arg("--owner")
        .arg(owner)
        .env("NO_PROXY", proxy_bypass_env())
        .env("no_proxy", proxy_bypass_env())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let Ok(mut cleanup) = command.spawn() else {
        return false;
    };
    let deadline = Instant::now() + SHUTDOWN_GRACE;
    while Instant::now() < deadline {
        match cleanup.try_wait() {
            Ok(Some(status)) => return status.success(),
            Err(_) => break,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
        }
    }
    let _ = cleanup.kill();
    let _ = cleanup.wait();
    false
}

/// A single native watchdog owns restart decisions. It never queues or replays
/// renderer requests and never takes a shutdown-induced exit as a crash.
fn watch_host(app: tauri::AppHandle, root: std::path::PathBuf, host: Arc<HostProcess>) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(250));
        if host.stopped() {
            return;
        }
        let failed = host.process.lock().ok().and_then(|mut slot| {
            slot.take_failed(|owned| !matches!(owned.child.try_wait(), Ok(None)))
        });
        let Some(mut owned) = failed else {
            continue;
        };
        if let Ok(mut origin) = host.origin.lock() {
            *origin = None;
        }
        stop_child(&mut owned.child);
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if window.set_enabled(false).is_err() {
            app.exit(1);
            return;
        }
        #[cfg(windows)]
        let owner = window.hwnd().map_or(0, |hwnd| hwnd.0 as usize);
        #[cfg(not(windows))]
        let owner = 0;
        if host.stopped() {
            return;
        }
        // Use the existing trusted-lock, exact-owner and health checks. This
        // helper cannot claim/start a hearth another window now supervises.
        if !cleanup_owner(&app, &root, &owned.owner) {
            recovery::cleanup_error(owner);
            app.exit(1);
            return;
        }
        if !recovery::runtime_retry(owner) {
            app.exit(0);
            return;
        }
        // Keep stale workspace controls disabled throughout a startup attempt.
        let _ = window.set_enabled(false);
        let started = recovery::retry(
            || {
                if host.stopped() {
                    return Err("app closing".into());
                }
                launch_host(&app, &root)
            },
            |_| !host.stopped() && recovery::startup_retry_at(owner),
        );
        let Ok((child, url)) = started else {
            app.exit(0);
            return;
        };
        let installed = host
            .process
            .lock()
            .expect("host state poisoned")
            .install(child);
        if let Err(mut owned) = installed {
            stop_child(&mut owned.child);
            let _ = cleanup_owner(&app, &root, &owned.owner);
            return;
        }
        if let Ok(mut origin) = host.origin.lock() {
            *origin = Some(url.origin());
        }
        if window.navigate(url).is_err() || window.set_enabled(true).is_err() {
            app.exit(1);
            return;
        }
    });
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    let cwd = env::current_dir().map_err(|_| "checkout root unavailable")?;
    let Some(root) = workspace::select_root(
        &args,
        &cwd,
        workspace::choose_folder,
        recovery::workspace_retry,
    )?
    else {
        return Ok(());
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            let started = recovery::retry(
                || launch_host(app.handle(), &root),
                |_| recovery::startup_retry(),
            );
            let Ok((child, url)) = started else {
                app.handle().exit(0);
                return Ok(());
            };
            let host = Arc::new(HostProcess {
                process: Mutex::new(lifecycle::Lifecycle::new(child)),
                origin: Mutex::new(Some(url.origin())),
            });
            app.manage(host.clone());
            let navigation = host.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Agent Forge Harness")
                .on_navigation(move |next| {
                    navigation
                        .origin
                        .lock()
                        .is_ok_and(|origin| origin.as_ref() == Some(&next.origin()))
                })
                .build()?;
            watch_host(app.handle().clone(), root.clone(), host);
            Ok(())
        })
        .build(tauri::generate_context!())?
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(host) = app.try_state::<Arc<HostProcess>>() {
                    host.shutdown();
                }
            }
        });
    Ok(())
}

fn main() {
    if run().is_err() {
        recovery::launch_error();
        #[cfg(debug_assertions)]
        eprintln!("desktop shell failed");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(raw: &str) -> String {
        serde_json::json!({"ok":true,"data":{"url":raw,"owner":"11111111-1111-4111-8111-111111111111"},"error":null}).to_string()
    }

    #[test]
    fn accepts_only_ephemeral_loopback_launch_urls() {
        let url = "http://127.0.0.1:49152/#launch=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(validated_url(url).unwrap().port(), Some(49152));
        for invalid in [
            "https://127.0.0.1:49152/#launch=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "http://localhost:49152/#launch=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "http://127.0.0.1:49152/other#launch=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "http://127.0.0.1:49152/?x=1#launch=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "http://user@127.0.0.1:49152/#launch=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "http://2130706433:49152/#launch=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "http://127.0.0.1:49152/#launch=ABC",
        ] { assert!(validated_url(invalid).is_err()); }
    }

    #[test]
    fn rejects_invalid_envelopes_and_oversize_lines() {
        let good = ready("http://127.0.0.1:49152/#launch=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
        let mut line = good.as_bytes().to_vec();
        line.push(b'\n');
        assert!(parse_ready(&line, line.len() as u64).is_ok());
        let bad = good.replace("\"ok\":true", "\"ok\":false");
        let mut bad_line = bad.into_bytes();
        bad_line.push(b'\n');
        assert!(parse_ready(&bad_line, bad_line.len() as u64).is_err());
        assert!(parse_ready(&line, MAX_READY_BYTES + 1).is_err());
        for owner in ["", "../../../other", "11111111-1111-4111-8111-11111111111g"] {
            let bad = good.replace("11111111-1111-4111-8111-111111111111", owner);
            let line = format!("{bad}\n");
            assert!(parse_ready(line.as_bytes(), line.len() as u64).is_err());
        }
        assert!(good.len() + 1 < MAX_READY_BYTES as usize);
    }

    #[test]
    fn loopback_proxy_bypass_preserves_and_combines_existing_entries() {
        assert_eq!(proxy_bypass("corp.example", ""), "corp.example,127.0.0.1");
        assert_eq!(
            proxy_bypass("localhost", "10.0.0.1"),
            "localhost,10.0.0.1,127.0.0.1"
        );
        assert_eq!(proxy_bypass("10.0.0.1,127.0.0.1", ""), "10.0.0.1,127.0.0.1");
        assert_eq!(proxy_bypass("", ""), "127.0.0.1");
    }
}
