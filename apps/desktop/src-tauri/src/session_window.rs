use crate::HostProcess;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use url::Url;

const MAX_WINDOWS: usize = 2;
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionTarget {
    project_id: String,
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shift_request_id: Option<String>,
}
fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
        && (value == "00000000-0000-0000-0000-000000000000"
            || value == "ffffffff-ffff-ffff-ffff-ffffffffffff"
            || (b"12345678".contains(&value.as_bytes()[14])
                && b"89ab".contains(&value.as_bytes()[19])))
}
impl SessionTarget {
    fn valid(&self) -> bool {
        let project = self.project_id.strip_prefix("project-");
        project.is_some_and(|id| {
            uuid(id) && id.as_bytes()[14] == b'4' && b"89ab".contains(&id.as_bytes()[19])
        }) && !self.session_id.is_empty()
            && self.session_id.len() <= 256
            && self
                .session_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
            && self.shift_request_id.as_deref().is_none_or(|request| {
                uuid(request) && self.session_id.strip_prefix("session-").is_some_and(uuid)
            })
    }
    fn url(&self, origin: &url::Origin) -> Result<Url, String> {
        if !self.valid() {
            return Err("Invalid session address.".into());
        }
        let mut url = Url::parse(&(origin.ascii_serialization() + "/"))
            .map_err(|_| "Window origin unavailable.")?;
        if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
            return Err("Window origin unavailable.".into());
        }
        let mut hash = format!(
            "/desktop/project/{}/sessions?selectionKind=session&selectionId={}",
            self.project_id, self.session_id
        );
        if let Some(request) = &self.shift_request_id {
            hash.push_str(&format!("&shiftRequestId={request}"));
        }
        hash.push_str("&sessionWindow=1");
        url.set_fragment(Some(&hash));
        Ok(url)
    }
}
#[derive(Clone)]
struct Slot {
    label: String,
    lease: u64,
    owner: String,
}
#[derive(Default)]
struct Slots {
    next: u64,
    entries: HashMap<SessionTarget, Slot>,
}
impl Slots {
    fn reserve(&mut self, target: &SessionTarget, owner: &str) -> Result<(Slot, bool), String> {
        if let Some(slot) = self.entries.get(target) {
            return if slot.owner == owner {
                Ok((slot.clone(), false))
            } else {
                Err("This window belongs to a retired host generation.".into())
            };
        }
        if self.entries.len() >= MAX_WINDOWS {
            return Err("Close a session window before opening another. The limit is two.".into());
        }
        self.next = self
            .next
            .checked_add(1)
            .ok_or("Window identities unavailable.")?;
        let slot = Slot {
            label: format!("session-popout-{}", self.next),
            lease: self.next,
            owner: owner.into(),
        };
        self.entries.insert(target.clone(), slot.clone());
        Ok((slot, true))
    }
    fn release(&mut self, target: &SessionTarget, slot: &Slot) {
        if self.entries.get(target).is_some_and(|current| {
            current.lease == slot.lease
                && current.owner == slot.owner
                && current.label == slot.label
        }) {
            self.entries.remove(target);
        }
    }
}
#[derive(Clone, Default)]
pub struct SessionWindows(Arc<Mutex<Slots>>);
#[derive(Serialize)]
pub struct WindowReply {
    state: &'static str,
    label: String,
}

fn current(host: &HostProcess, origin: &url::Origin, owner: &str) -> bool {
    host.current_generation()
        .is_some_and(|(current_origin, current_owner)| {
            current_origin == *origin && current_owner == owner
        })
}
pub fn install_capability(app: &tauri::AppHandle, origin: &url::Origin) -> tauri::Result<()> {
    app.add_capability(
        serde_json::json!({
            "identifier":"session-popout-main",
            "description":"Open a bounded session view from this app's trusted main window.",
            "local":false,
            "windows":["main"],
            "remote":{"urls":[format!("{}/*",origin.ascii_serialization())]},
            "permissions":["allow-open-session-popout"]
        })
        .to_string(),
    )
}
/// Native window creation is async on Windows; no generic native permission is granted.
#[tauri::command]
pub async fn open_session_popout(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request: SessionTarget,
    windows: State<'_, SessionWindows>,
    host: State<'_, Arc<HostProcess>>,
) -> Result<WindowReply, String> {
    if window.label() != "main" || !request.valid() {
        return Err("Session window request refused.".into());
    }
    let (origin, owner) = host
        .current_generation()
        .ok_or("The current host is unavailable.")?;
    let caller = window.url().map_err(|_| "Window origin unavailable.")?;
    if caller.origin() != origin || caller.path() != "/" || caller.query().is_some() {
        return Err("Window origin unavailable.".into());
    }
    let url = request.url(&origin)?;
    let (slot, new) = windows
        .0
        .lock()
        .map_err(|_| "Window registry unavailable.")?
        .reserve(&request, &owner)?;
    if !current(&host, &origin, &owner) {
        if new {
            windows
                .0
                .lock()
                .map_err(|_| "Window registry unavailable.")?
                .release(&request, &slot);
        }
        return Err("The current host changed. No window was opened.".into());
    }
    if !new {
        let Some(existing) = app.get_webview_window(&slot.label) else {
            return Ok(WindowReply {
                state: "opening",
                label: slot.label,
            });
        };
        if existing
            .url()
            .ok()
            .is_none_or(|value| value.origin() != origin)
            || !current(&host, &origin, &owner)
        {
            return Err("The existing window could not be verified.".into());
        }
        existing
            .show()
            .and_then(|_| existing.unminimize())
            .and_then(|_| existing.set_focus())
            .map_err(|_| "The existing window could not be revealed.")?;
        return Ok(WindowReply {
            state: "focused",
            label: slot.label,
        });
    }
    let navigation_host = host.inner().clone();
    let navigation_origin = origin.clone();
    let navigation_owner = owner.clone();
    let context = serde_json::to_string(&request).map_err(|_| "Session address unavailable.")?;
    let script=format!("Object.defineProperty(window,'__AF_SESSION_WINDOW_TARGET__',{{value:Object.freeze({context}),writable:false,configurable:false}});");
    let built = WebviewWindowBuilder::new(&app, &slot.label, WebviewUrl::External(url))
        .title(format!("Agent Forge — {}", request.session_id))
        .inner_size(720.0, 820.0)
        .min_inner_size(480.0, 400.0)
        .visible(false)
        .initialization_script(script)
        .on_navigation(move |next| {
            next.origin() == navigation_origin
                && next.path() == "/"
                && next.query().is_none()
                && current(&navigation_host, &navigation_origin, &navigation_owner)
        })
        .build();
    let child = match built {
        Ok(child) => child,
        Err(_) => {
            windows
                .0
                .lock()
                .map_err(|_| "Window registry unavailable.")?
                .release(&request, &slot);
            return Err("The session window could not be created.".into());
        }
    };
    let cleanup_windows = windows.inner().clone();
    let cleanup_request = request.clone();
    let cleanup_slot = slot.clone();
    child.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Ok(mut slots) = cleanup_windows.0.lock() {
                slots.release(&cleanup_request, &cleanup_slot);
            }
        }
    });
    if !current(&host, &origin, &owner) {
        let _ = child.close();
        return Err("The host changed while opening the window. Relaunch Forge explicitly.".into());
    }
    child.show().and_then(|_| child.set_focus()).map_err(|_| {
        "The session window was created but could not be revealed. Check open Forge windows."
    })?;
    Ok(WindowReply {
        state: "created",
        label: slot.label,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn target(n: u64) -> SessionTarget {
        SessionTarget {
            project_id: "project-11111111-1111-4111-8111-111111111111".into(),
            session_id: format!("observed-{n}"),
            shift_request_id: None,
        }
    }
    #[test]
    fn builds_scoped_secret_free_urls_and_refuses_untrusted_fields() {
        let origin = Url::parse("http://127.0.0.1:49152/").unwrap().origin();
        let url = target(1).url(&origin).unwrap();
        assert_eq!(url.as_str(),"http://127.0.0.1:49152/#/desktop/project/project-11111111-1111-4111-8111-111111111111/sessions?selectionKind=session&selectionId=observed-1&sessionWindow=1");
        for id in ["", "../outside", "a&selectionId=other", "a b", "é", "a%2fb"] {
            let mut bad = target(1);
            bad.session_id = id.into();
            assert!(bad.url(&origin).is_err());
        }
        assert!(target(1)
            .url(&Url::parse("https://example.com/").unwrap().origin())
            .is_err());
        let mut fields = serde_json::to_value(target(1)).unwrap();
        fields["url"] = serde_json::json!("http://other/");
        assert!(serde_json::from_value::<SessionTarget>(fields).is_err());
    }
    #[test]
    fn shift_ids_match_the_browser_uuid_contract() {
        for valid in [
            "00000000-0000-0000-0000-000000000000",
            "ffffffff-ffff-ffff-ffff-ffffffffffff",
            "11111111-1111-8111-b111-111111111111",
        ] {
            let mut request = target(1);
            request.session_id = format!("session-{valid}");
            request.shift_request_id = Some(valid.into());
            assert!(request.valid());
        }
        for invalid in [
            "11111111-1111-0111-8111-111111111111",
            "11111111-1111-4111-0111-111111111111",
            "11111111-1111-9111-8111-111111111111",
            "11111111-1111-4111-C111-111111111111",
        ] {
            let mut request = target(1);
            request.session_id = "session-11111111-1111-4111-8111-111111111111".into();
            request.shift_request_id = Some(invalid.into());
            assert!(!request.valid());
            request.shift_request_id = Some("11111111-1111-4111-8111-111111111111".into());
            request.session_id = format!("session-{invalid}");
            assert!(!request.valid());
        }
    }
    #[test]
    fn deduplicates_pending_targets_and_bounds_all_children() {
        let mut slots = Slots::default();
        let (first, new) = slots.reserve(&target(1), "owner-a").unwrap();
        assert!(new);
        let (again, new) = slots.reserve(&target(1), "owner-a").unwrap();
        assert!(!new);
        assert_eq!(first.label, again.label);
        for n in 2..=2 {
            assert!(slots.reserve(&target(n), "owner-a").is_ok());
        }
        assert!(slots.reserve(&target(3), "owner-a").is_err());
        assert_eq!(slots.entries.len(), 2);
    }
    #[test]
    fn stale_destruction_cannot_release_a_replacement_or_generation() {
        let mut slots = Slots::default();
        let (old, _) = slots.reserve(&target(1), "owner-a").unwrap();
        assert!(slots.reserve(&target(1), "owner-b").is_err());
        slots.release(&target(1), &old);
        let (replacement, _) = slots.reserve(&target(1), "owner-a").unwrap();
        slots.release(&target(1), &old);
        assert_eq!(slots.entries[&target(1)].label, replacement.label);
        let mut wrong = replacement.clone();
        wrong.owner = "owner-b".into();
        slots.release(&target(1), &wrong);
        assert_eq!(slots.entries.len(), 1);
    }
}
