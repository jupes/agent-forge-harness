use serde::Serialize;
use std::ffi::OsString;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const MAX_URI_BYTES: usize = 2048;

#[derive(Clone, Serialize)]
struct Envelope {
    version: u8,
    generation: String,
    sequence: u32,
    uri: String,
}

struct Pending {
    sequence: u32,
    latest: Option<Envelope>,
}

pub struct DeepLinks {
    generation: String,
    inner: Mutex<Pending>,
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

/// Check the original command-line spelling before the URL library normalizes it.
fn valid_uri(uri: &str) -> bool {
    if uri.len() > MAX_URI_BYTES {
        return false;
    }
    let Some(rest) = uri.strip_prefix("agent-forge://") else {
        return false;
    };
    let Some((kind, raw)) = rest.split_once('/') else {
        return false;
    };
    if !matches!(kind, "project" | "bead" | "session")
        || raw.is_empty()
        || raw.chars().any(|value| matches!(value, '/' | '?' | '#'))
    {
        return false;
    }
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let Some(high) = bytes.get(index + 1).and_then(|value| hex(*value)) else {
                return false;
            };
            let Some(low) = bytes.get(index + 2).and_then(|value| hex(*value)) else {
                return false;
            };
            decoded.push(high * 16 + low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    let Ok(id) = std::str::from_utf8(&decoded) else {
        return false;
    };
    !matches!(id, "." | "..")
        && id.encode_utf16().count() <= 256
        && !id.chars().any(char::is_control)
        && !id
            .chars()
            .all(|value| value.is_whitespace() || value == '\u{feff}')
}

/// Multiple product arguments are one invalid request, never an arbitrary first target.
fn request<'a>(args: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let mut selected = None;
    for argument in args {
        if argument.starts_with("agent-forge:") {
            if selected.is_some() {
                return Some(String::new());
            }
            selected = Some(argument);
        }
    }
    selected.map(|uri| {
        if valid_uri(uri) {
            uri.to_owned()
        } else {
            String::new()
        }
    })
}

pub fn workspace_args(args: &[OsString]) -> Vec<OsString> {
    args.iter()
        .filter(|argument| {
            !argument
                .to_str()
                .is_some_and(|value| value.starts_with("agent-forge:"))
        })
        .cloned()
        .collect()
}

impl DeepLinks {
    pub fn new(args: &[OsString]) -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let links = Self {
            generation: format!("p-{}-{stamp:x}", std::process::id()),
            inner: Mutex::new(Pending {
                sequence: 0,
                latest: None,
            }),
        };
        if let Some(uri) = request(args.iter().filter_map(|argument| argument.to_str())) {
            links.enqueue(uri);
        }
        links
    }

    fn enqueue(&self, uri: String) -> bool {
        let Ok(mut pending) = self.inner.lock() else {
            return false;
        };
        let Some(sequence) = pending.sequence.checked_add(1) else {
            return false;
        };
        pending.sequence = sequence;
        pending.latest = Some(Envelope {
            version: 1,
            generation: self.generation.clone(),
            sequence,
            uri: if valid_uri(&uri) { uri } else { String::new() },
        });
        true
    }

    fn snapshot(&self) -> Option<Envelope> {
        self.inner
            .lock()
            .ok()
            .and_then(|pending| pending.latest.clone())
    }
}

/// The secondary process can only focus the existing main window and queue navigation data.
pub fn receive(app: &tauri::AppHandle, args: &[String]) {
    if let Some(uri) = request(args.iter().map(String::as_str)) {
        if let Some(links) = app.try_state::<DeepLinks>() {
            links.enqueue(uri);
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        deliver(&window);
    }
}

/// The current host origin and the main label are checked again for every delivery.
pub fn deliver(window: &tauri::WebviewWindow) {
    if window.label() != "main" {
        return;
    }
    let Ok(url) = window.url() else {
        return;
    };
    let app = window.app_handle();
    let Some(host) = app.try_state::<Arc<super::HostProcess>>() else {
        return;
    };
    if !host
        .origin
        .lock()
        .is_ok_and(|origin| origin.as_ref() == Some(&url.origin()))
    {
        return;
    }
    let Some(links) = app.try_state::<DeepLinks>() else {
        return;
    };
    let Some(latest) = links.snapshot() else {
        return;
    };
    let Ok(data) = serde_json::to_string(&latest) else {
        return;
    };
    let script = format!(
        r#"window.__AGENT_FORGE_DEEP_LINK__={data};window.dispatchEvent(new CustomEvent("agent-forge-deep-link",{{detail:window.__AGENT_FORGE_DEEP_LINK__}}));"#
    );
    let _ = window.eval(&script);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closed_routes_validate_original_spelling_and_decode_once() {
        for uri in [
            "agent-forge://project/project-one",
            "agent-forge://bead/caf%C3%A9",
            "agent-forge://bead/alpha%2Fchild",
            "agent-forge://session/session%252Fone",
        ] {
            assert!(valid_uri(uri), "valid object identifier was rejected");
        }
    }

    #[test]
    fn invalid_routes_never_become_a_normalized_valid_target() {
        for uri in [
            "https://project/one",
            "agent-forge://unknown/one",
            "agent-forge://project/",
            "agent-forge://project/a/../b",
            "agent-forge://project/a?root=C:/private",
            "agent-forge://project/a#operator=private",
            "agent-forge://user@project/one",
            "agent-forge://project:80/one",
            "agent-forge://project/%ZZ",
            "agent-forge://project/%ED%A0%80",
            "agent-forge://project/%00",
            "agent-forge://project/%7F",
            "agent-forge://project/%20",
            "agent-forge://project/%EF%BB%BF",
            "agent-forge://project/%2E%2E",
        ] {
            assert!(!valid_uri(uri), "invalid target was accepted");
        }
        assert!(!valid_uri(&format!(
            "agent-forge://bead/{}",
            "a".repeat(257)
        )));
        assert!(!valid_uri(&format!(
            "agent-forge://bead/{}",
            "😀".repeat(129)
        )));
        assert!(!valid_uri(&format!(
            "agent-forge://bead/{}",
            "%61".repeat(700)
        )));
    }

    #[test]
    fn workspace_selection_never_receives_a_product_uri_or_link_fields() {
        let args = [
            OsString::from("--root"),
            OsString::from("/trusted"),
            OsString::from("agent-forge://project/one?root=/foreign"),
        ];
        assert_eq!(
            workspace_args(&args),
            vec![OsString::from("--root"), OsString::from("/trusted")]
        );
    }

    #[test]
    fn multiple_product_arguments_are_an_invalid_request() {
        assert_eq!(request(["app.exe", "--from-login"]), None);
        assert_eq!(
            request(["agent-forge://project/one", "agent-forge://project/two"]),
            Some(String::new())
        );
        assert_eq!(request(["agent-forge:invalid"]), Some(String::new()));
    }

    #[test]
    fn only_the_latest_bounded_request_remains_and_incarnation_is_stable() {
        let links = DeepLinks::new(&[]);
        assert!(links.enqueue("agent-forge://project/one".to_owned()));
        let first = links.snapshot().unwrap();
        assert_eq!(first.sequence, 1);
        assert!(links.enqueue("agent-forge://project/two".to_owned()));
        let second = links.snapshot().unwrap();
        assert_eq!(second.sequence, 2);
        assert_eq!(second.generation, first.generation);
        assert_eq!(second.uri, "agent-forge://project/two");
        assert!(links.enqueue("agent-forge://project/one?operator=private".to_owned()));
        assert_eq!(links.snapshot().unwrap().uri, "");
    }

    #[test]
    fn exhaustion_does_not_wrap_or_reuse_a_consumed_sequence() {
        let links = DeepLinks::new(&[]);
        links.inner.lock().unwrap().sequence = u32::MAX;
        assert!(!links.enqueue("agent-forge://project/one".to_owned()));
        assert!(links.snapshot().is_none());
    }
}
