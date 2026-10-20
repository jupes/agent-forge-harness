#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::{
    env, fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
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

fn read_ready(stdout: std::process::ChildStdout) -> Result<Url, &'static str> {
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

fn parse_ready(line: &[u8], count: u64) -> Result<Url, &'static str> {
    if count == 0 || count > MAX_READY_BYTES || line.last() != Some(&b'\n') {
        return Err("invalid host handshake");
    }
    let body = line.strip_suffix(b"\n").unwrap_or(line);
    let envelope: ReadyEnvelope =
        serde_json::from_slice(body).map_err(|_| "invalid host handshake")?;
    if !envelope.ok || !envelope.error.is_null() {
        return Err("host startup failed");
    }
    validated_url(&envelope.data.url)
}

fn checkout_root() -> Result<PathBuf, &'static str> {
    let mut args = env::args_os().skip(1);
    let root = match args.next() {
        Some(flag) if flag == "--root" => args
            .next()
            .map(PathBuf::from)
            .ok_or("missing checkout root")?,
        Some(_) => return Err("unexpected desktop argument"),
        None => env::current_dir().map_err(|_| "checkout root unavailable")?,
    };
    if args.next().is_some() {
        return Err("unexpected desktop argument");
    }
    let root = fs::canonicalize(root).map_err(|_| "invalid checkout root")?;
    if !root.is_dir()
        || !root.join("scripts/hearth/server.ts").is_file()
        || !root.join(".git").exists()
    {
        return Err("invalid checkout root");
    }
    Ok(root)
}

fn launch_host(
    app: &tauri::AppHandle,
    root: &Path,
) -> Result<(Child, Url), Box<dyn std::error::Error>> {
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
        Ok(url) => Ok((child, url)),
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

struct HostProcess(Mutex<Option<Child>>);
impl HostProcess {
    fn shutdown(&self) {
        if let Ok(mut slot) = self.0.lock() {
            if let Some(mut child) = slot.take() {
                stop_child(&mut child);
            }
        }
    }
}
impl Drop for HostProcess {
    fn drop(&mut self) {
        if let Ok(slot) = self.0.get_mut() {
            if let Some(mut child) = slot.take() {
                stop_child(&mut child);
            }
        }
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let root = checkout_root()?;
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |app| {
            let (child, url) = launch_host(app.handle(), &root)?;
            let origin = url.origin();
            app.manage(HostProcess(Mutex::new(Some(child))));
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Agent Forge Harness")
                .on_navigation(move |next| next.origin() == origin)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())?
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<HostProcess>().shutdown();
            }
        });
    Ok(())
}

fn main() {
    if run().is_err() {
        #[cfg(debug_assertions)]
        eprintln!("desktop shell failed");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(raw: &str) -> String {
        serde_json::json!({"ok":true,"data":{"url":raw},"error":null}).to_string()
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
