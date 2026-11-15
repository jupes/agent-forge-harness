//! Narrow main-window broker. Private selectors never cross the IPC boundary.
use crate::{config_transform::Client, registration_context::RegistrationContext, HostProcess};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{Manager, State, WebviewWindow};
#[cfg(windows)]
#[path = "mcp_registration_windows.rs"]
mod engine;
#[derive(Clone, Default)]
pub struct RegistrationService {
    #[cfg(windows)]
    state: Arc<std::sync::Mutex<engine::RegistrationState>>,
}
#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Review { client: Client },
    Commit { request_id: String },
    Recover { request_id: String },
}
fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}
fn reply(result: Result<Value, &'static str>) -> Value {
    match result {
        Ok(data) => json!({"ok":true,"data":data,"error":null}),
        Err(error) => json!({"ok":false,"data":null,"error":error}),
    }
}
fn current(host: &HostProcess, origin: &url::Origin, owner: &str) -> bool {
    host.current_generation()
        .is_some_and(|(a, b)| a == *origin && b == owner)
}
fn private_context(
    host: &HostProcess,
    origin: &url::Origin,
    owner: &str,
) -> Option<RegistrationContext> {
    if !current(host, origin, owner) {
        return None;
    }
    let mut slot = host.process.lock().ok()?;
    let owned = slot.current_mut()?;
    if owned.owner != owner || !matches!(owned.child.try_wait(), Ok(None)) {
        return None;
    }
    owned.registration.clone()
}
pub fn install_capability(app: &tauri::AppHandle, origin: &url::Origin) -> tauri::Result<()> {
    app.add_capability(json!({
        "identifier":"mcp-registration-main-window",
        "description":"Review, explicitly confirm and recover a fixed MCP client registration in the trusted main window.",
        "local":false,"windows":["main"],
        "remote":{"urls":[format!("{}/*",origin.ascii_serialization())]},
        "permissions":["mcp-registration-main"]
    }).to_string())
}
#[tauri::command]
pub async fn mcp_registration(
    window: WebviewWindow,
    request: Request,
    service: State<'_, RegistrationService>,
    host: State<'_, Arc<HostProcess>>,
) -> Result<Value, ()> {
    let Some((origin, owner)) = host.current_generation() else {
        return Ok(reply(Err("disconnected")));
    };
    if window.label() != "main"
        || window
            .url()
            .ok()
            .is_none_or(|url| url.origin() != origin || url.path() != "/" || url.query().is_some())
    {
        return Ok(reply(Err("native-unavailable")));
    }
    if matches!(&request, Request::Commit { request_id } | Request::Recover { request_id } if !valid_id(request_id))
    {
        return Ok(reply(Err("invalid-response")));
    }
    let Some(context) = private_context(&host, &origin, &owner) else {
        return Ok(reply(Err("scope-changed")));
    };
    #[cfg(not(windows))]
    {
        let _ = (request, service, context);
        Ok(reply(Err("unsupported")))
    }
    #[cfg(windows)]
    {
        let registry = service.state.clone();
        let host = host.inner().clone();
        Ok(
            match tauri::async_runtime::spawn_blocking(move || {
                let mut state = registry.try_lock().map_err(|_| "busy")?;
                let still_current = || current(&host, &origin, &owner);
                if !still_current() {
                    return Err("scope-changed");
                }
                match request {
                    Request::Review { client } => {
                        engine::review(&mut state, &context, &owner, client)
                    }
                    Request::Commit { request_id } => {
                        engine::commit(&mut state, &context, &owner, &request_id, still_current)
                    }
                    Request::Recover { request_id } => {
                        engine::recover(&mut state, &context, &request_id)
                    }
                }
            })
            .await
            {
                Ok(result) => reply(result),
                Err(_) => reply(Err("unavailable")),
            },
        )
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn broker_accepts_only_closed_operations_and_rejects_arbitrary_selectors() {
        for raw in [
            json!({"operation":"review","client":"claude"}),
            json!({"operation":"commit","requestId":"ad000000-0000-4000-8000-000000000001"}),
            json!({"operation":"recover","requestId":"ad000000-0000-4000-8000-000000000001"}),
        ] {
            assert!(serde_json::from_value::<Request>(raw).is_ok());
        }
        for raw in [
            json!({"operation":"review","client":"foreign"}),
            json!({"operation":"review","client":"cursor","file":"private"}),
            json!({"operation":"commit","requestId":"id","command":"foreign"}),
            json!({"operation":"open","client":"codex"}),
        ] {
            assert!(serde_json::from_value::<Request>(raw).is_err());
        }
    }
    #[test]
    fn recovery_ids_cannot_select_paths_or_noncanonical_records() {
        assert!(valid_id("ad000000-0000-4000-8000-000000000001"));
        for id in [
            "",
            "../private",
            "ad000000-0000-4000-8000-00000000000Z",
            "AD000000-0000-4000-8000-000000000001",
        ] {
            assert!(!valid_id(id));
        }
    }
}
