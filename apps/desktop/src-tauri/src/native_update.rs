//! Explicit signed updater broker; no renderer-selected transport or filesystem selectors.
use crate::{
    native_update_policy as policy, registration_context::RegistrationContext, HostProcess,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{Manager, State, WebviewWindow};
#[cfg(windows)]
use {
    crate::private_files,
    serde::Serialize,
    sha2::{Digest, Sha256},
    std::path::{Path, PathBuf},
    tauri_plugin_updater::UpdaterExt,
};

#[derive(Default)]
pub struct UpdateService {
    #[cfg(windows)]
    state: tokio::sync::Mutex<UpdateState>,
}
#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Status { request_id: Option<String> },
    Check { request_id: String },
    Download { request_id: String },
    Install { request_id: String },
}
fn reply(result: Result<Value, ()>) -> Value {
    match result {
        Ok(data) => json!({"ok":true,"data":data,"error":null}),
        Err(()) => json!({"ok":false,"data":null,"error":"native-update-unavailable"}),
    }
}
pub fn install_capability(app: &tauri::AppHandle, origin: &url::Origin) -> tauri::Result<()> {
    app.add_capability(json!({
        "identifier":"native-update-main-window","description":"Explicit signed update review and installation in the trusted main window.",
        "local":false,"windows":["main"],"remote":{"urls":[format!("{}/*",origin.ascii_serialization())]},
        "permissions":["native-update-main"]
    }).to_string())
}
#[tauri::command]
pub async fn native_update(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request: Request,
    service: State<'_, UpdateService>,
    host: State<'_, Arc<HostProcess>>,
) -> Result<Value, ()> {
    let Some((origin, owner)) = host.current_generation() else {
        return Ok(reply(Err(())));
    };
    if window.label() != "main"
        || window
            .url()
            .ok()
            .is_none_or(|u| u.origin() != origin || u.path() != "/" || u.query().is_some())
    {
        return Ok(reply(Err(())));
    }
    let id = match &request {
        Request::Status { request_id } => request_id.as_deref(),
        Request::Check { request_id }
        | Request::Download { request_id }
        | Request::Install { request_id } => Some(request_id.as_str()),
    };
    if id.is_some_and(|id| !policy::valid_id(id)) {
        return Ok(reply(Err(())));
    }
    let context = host.process.lock().ok().and_then(|mut slot| {
        let owned = slot.current_mut()?;
        if owned.owner != owner || !matches!(owned.child.try_wait(), Ok(None)) {
            return None;
        }
        owned.registration.clone()
    });
    let Some(context) = context else {
        return Ok(reply(Err(())));
    };
    #[cfg(not(windows))]
    {
        let _ = (app, service, context, request);
        Ok(reply(Err(())))
    }
    #[cfg(windows)]
    {
        let Ok(mut state) = service.state.try_lock() else {
            return Ok(reply(Err(())));
        };
        let result = execute(&app, &host, &origin, &owner, &context, &mut state, request).await;
        Ok(reply(result))
    }
}

#[cfg(windows)]
#[derive(Default)]
struct UpdateState {
    cached: Option<Cached>,
}
#[cfg(windows)]
struct Cached {
    id: String,
    owner: String,
    created_at: u64,
    update: tauri_plugin_updater::Update,
    bytes: Option<Vec<u8>>,
}
#[cfg(windows)]
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepared {
    schema_version: u8,
    request_id: String,
    root: String,
    home: String,
    version: String,
    source_version: String,
    package_sha256: String,
    prepared_at: u64,
}
#[cfg(windows)]
fn now() -> Result<u64, ()> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| ())?
        .as_millis()
        .try_into()
        .map_err(|_| ())
}
#[cfg(windows)]
fn key() -> Option<&'static str> {
    option_env!("AGENT_FORGE_UPDATER_PUBLIC_KEY")
        .filter(|key| !key.trim().is_empty() && key.len() <= 4096)
}
#[cfg(windows)]
fn scope(context: &RegistrationContext) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&["native-update", &context.root, &context.home])
                .expect("fixed metadata")
        )
    )
}
#[cfg(windows)]
fn result(
    context: &RegistrationContext,
    state: &str,
    id: Option<&str>,
    version: Option<&str>,
) -> Value {
    json!({"schemaVersion":1,"currentVersion":env!("CARGO_PKG_VERSION"),"scopeKey":scope(context),"requestId":id,"version":version,"state":state})
}
#[cfg(windows)]
fn exists(path: &Path) -> Result<bool, ()> {
    match std::fs::symlink_metadata(path) {
        Ok(info) if info.is_symlink() => Err(()),
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(()),
    }
}
#[cfg(windows)]
fn folder(context: &RegistrationContext) -> PathBuf {
    Path::new(&context.home).join("native-updates")
}
#[cfg(windows)]
fn record_path(directory: &Path, id: &str, phase: &str) -> PathBuf {
    directory.join(format!("{id}-{phase}.json"))
}
#[cfg(windows)]
fn read_record(
    path: &Path,
    context: &RegistrationContext,
    id: Option<&str>,
) -> Result<(Prepared, Vec<u8>), ()> {
    let bytes = private_files::read(path, 8192).map_err(|_| ())?;
    let value: Prepared = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if value.schema_version != 1
        || !policy::valid_id(&value.request_id)
        || id.is_some_and(|id| id != value.request_id)
        || value.root != context.root
        || value.home != context.home
        || value.package_sha256.len() != 64
        || !value
            .package_sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || value.version.len() > 100
        || value.source_version.len() > 100
        || semver::Version::parse(&value.version).is_err()
        || semver::Version::parse(&value.source_version).is_err()
    {
        return Err(());
    }
    Ok((value, bytes))
}
#[cfg(windows)]
fn observed(version: &str) -> Result<bool, ()> {
    Ok(
        semver::Version::parse(env!("CARGO_PKG_VERSION")).map_err(|_| ())?
            >= semver::Version::parse(version).map_err(|_| ())?,
    )
}
#[cfg(windows)]
fn authorization(
    context: &RegistrationContext,
    operation: &str,
    id: &str,
    prepared_at: u64,
) -> Result<(), ()> {
    let path = Path::new(&context.home)
        .join("update-authorizations")
        .join(format!("{operation}.json"));
    let bytes = private_files::read(&path, 8192).map_err(|_| ())?;
    policy::authorize(
        &bytes,
        operation,
        id,
        &context.root,
        &context.home,
        prepared_at,
        now()?,
    )
}
#[cfg(windows)]
fn status(
    context: &RegistrationContext,
    state: &UpdateState,
    id: Option<&str>,
) -> Result<Value, ()> {
    let directory = folder(context);
    if !exists(&directory)? {
        return if id.is_none() {
            Ok(result(
                context,
                if key().is_some() {
                    "unavailable"
                } else {
                    "unconfigured"
                },
                None,
                None,
            ))
        } else {
            Err(())
        };
    }
    let _pin = private_files::directory(&directory, false).map_err(|_| ())?;
    let gate = directory.join("installation-attempt.json");
    let selected = if let Some(id) = id {
        Some(id.to_owned())
    } else if exists(&gate)? {
        Some(read_record(&gate, context, None)?.0.request_id)
    } else {
        None
    };
    if let Some(id) = selected {
        let _lease = private_files::lease(&directory.join("update.lock"), false).map_err(|_| ())?;
        let (prepared, prepared_bytes) = read_record(
            &record_path(&directory, &id, "prepared"),
            context,
            Some(&id),
        )?;
        let attempt = record_path(&directory, &id, "attempt");
        let phase = if exists(&attempt)? {
            if !private_files::receipt(&attempt, &prepared_bytes) {
                return Err(());
            }
            let refused = record_path(&directory, &id, "not-launched");
            if exists(&refused)? {
                if !private_files::receipt(&refused, &prepared_bytes) {
                    return Err(());
                }
                "not-attempted"
            } else if observed(&prepared.version)? {
                "version-observed"
            } else {
                "install-unknown"
            }
        } else {
            "not-attempted"
        };
        return Ok(result(context, phase, Some(&id), Some(&prepared.version)));
    }
    if let Some(cache) = &state.cached {
        return Ok(result(
            context,
            if cache.bytes.is_some() {
                "downloaded"
            } else {
                "available"
            },
            Some(&cache.id),
            Some(&cache.update.version),
        ));
    }
    Ok(result(
        context,
        if key().is_some() {
            "unavailable"
        } else {
            "unconfigured"
        },
        None,
        None,
    ))
}
#[cfg(windows)]
async fn fetch_bounded(
    url: url::Url,
    max: usize,
    timeout: std::time::Duration,
) -> Result<Vec<u8>, ()> {
    if !policy::publisher_transport(&url) {
        return Err(());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !policy::publisher_transport(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .user_agent("Agent-Forge-Desktop-Updater")
        .build()
        .map_err(|_| ())?;
    let mut response = client.get(url).send().await.map_err(|_| ())?;
    if response.status() != reqwest::StatusCode::OK
        || response.content_length().is_some_and(|n| n > max as u64)
    {
        return Err(());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if bytes.len().checked_add(chunk.len()).is_none_or(|n| n > max) {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err(());
    }
    Ok(bytes)
}
#[cfg(windows)]
fn current(host: &HostProcess, origin: &url::Origin, owner: &str) -> bool {
    host.current_generation()
        .is_some_and(|(a, b)| a == *origin && b == owner)
}
#[cfg(windows)]
async fn execute(
    app: &tauri::AppHandle,
    host: &Arc<HostProcess>,
    origin: &url::Origin,
    owner: &str,
    context: &RegistrationContext,
    state: &mut UpdateState,
    request: Request,
) -> Result<Value, ()> {
    if !current(host, origin, owner) {
        return Err(());
    }
    if let Request::Status { request_id } = &request {
        return status(context, state, request_id.as_deref());
    }
    let Some(public_key) = key() else {
        return Ok(result(context, "unconfigured", None, None));
    };
    match request {
        Request::Status { .. } => unreachable!(),
        Request::Check { request_id } => {
            authorization(context, "check", &request_id, 0)?;
            let bytes = fetch_bounded(
                policy::ENDPOINT.parse().map_err(|_| ())?,
                policy::METADATA_LIMIT,
                std::time::Duration::from_secs(10),
            )
            .await?;
            if !current(host, origin, owner) {
                return Err(());
            }
            let (raw, _version) = policy::stable_manifest(&bytes)?;
            let updater = app
                .updater_builder()
                .pubkey(public_key)
                .target(policy::TARGET)
                .endpoints(vec![policy::ENDPOINT.parse().map_err(|_| ())?])
                .map_err(|_| ())?
                .restart_after_install(false)
                .clear_installer_args()
                .build()
                .map_err(|_| ())?;
            let Some(update) = updater.restore_update(raw).map_err(|_| ())? else {
                state.cached = None;
                return Ok(result(context, "current", Some(&request_id), None));
            };
            policy::package_url(update.download_url.as_str(), &update.version)?;
            let answer = result(
                context,
                "available",
                Some(&request_id),
                Some(&update.version),
            );
            state.cached = Some(Cached {
                id: request_id,
                owner: owner.to_owned(),
                created_at: now()?,
                update,
                bytes: None,
            });
            Ok(answer)
        }
        Request::Download { request_id } => {
            let cache = state.cached.as_mut().ok_or(())?;
            if cache.id != request_id
                || cache.owner != owner
                || now()?
                    .checked_sub(cache.created_at)
                    .is_none_or(|age| age >= policy::TTL_MS)
            {
                return Err(());
            }
            if cache.bytes.is_some() {
                return Ok(result(
                    context,
                    "downloaded",
                    Some(&cache.id),
                    Some(&cache.update.version),
                ));
            }
            authorization(context, "download", &request_id, cache.created_at)?;
            let bytes = fetch_bounded(
                cache.update.download_url.clone(),
                policy::PACKAGE_LIMIT,
                std::time::Duration::from_secs(120),
            )
            .await?;
            if !current(host, origin, owner) {
                return Err(());
            }
            cache.update.verify(&bytes).map_err(|_| ())?;
            let directory = folder(context);
            let _pin = private_files::directory(&directory, true).map_err(|_| ())?;
            let _lease =
                private_files::lease(&directory.join("update.lock"), true).map_err(|_| ())?;
            if std::fs::read_dir(&directory)
                .map_err(|_| ())?
                .take(2049)
                .count()
                > 2048
            {
                return Err(());
            }
            let prepared = Prepared {
                schema_version: 1,
                request_id: request_id.clone(),
                root: context.root.clone(),
                home: context.home.clone(),
                version: cache.update.version.clone(),
                source_version: env!("CARGO_PKG_VERSION").to_owned(),
                package_sha256: format!("{:x}", Sha256::digest(&bytes)),
                prepared_at: cache.created_at,
            };
            let encoded = serde_json::to_vec(&prepared).map_err(|_| ())?;
            private_files::create(&record_path(&directory, &request_id, "prepared"), &encoded)
                .map_err(|_| ())?;
            cache.bytes = Some(bytes);
            Ok(result(
                context,
                "downloaded",
                Some(&cache.id),
                Some(&cache.update.version),
            ))
        }
        Request::Install { request_id } => {
            let cache = state.cached.as_ref().ok_or(())?;
            if cache.id != request_id
                || cache.owner != owner
                || now()?
                    .checked_sub(cache.created_at)
                    .is_none_or(|age| age >= policy::TTL_MS)
            {
                return Err(());
            }
            authorization(context, "install", &request_id, cache.created_at)?;
            let bytes = cache.bytes.as_ref().ok_or(())?;
            cache.update.verify(bytes).map_err(|_| ())?;
            let directory = folder(context);
            let _pin = private_files::directory(&directory, false).map_err(|_| ())?;
            let _lease =
                private_files::lease(&directory.join("update.lock"), false).map_err(|_| ())?;
            let (prepared, encoded) = read_record(
                &record_path(&directory, &request_id, "prepared"),
                context,
                Some(&request_id),
            )?;
            if prepared.version != cache.update.version
                || prepared.package_sha256 != format!("{:x}", Sha256::digest(bytes))
            {
                return Err(());
            }
            let gate = directory.join("installation-attempt.json");
            if exists(&gate)? {
                let (old, old_bytes) = read_record(&gate, context, None)?;
                let old_attempt = record_path(&directory, &old.request_id, "attempt");
                let (_, old_prepared) = read_record(
                    &record_path(&directory, &old.request_id, "prepared"),
                    context,
                    Some(&old.request_id),
                )?;
                if old_prepared != old_bytes {
                    return Err(());
                }
                if exists(&old_attempt)? {
                    if !private_files::receipt(&old_attempt, &old_bytes) {
                        return Err(());
                    }
                    let refused = record_path(&directory, &old.request_id, "not-launched");
                    if exists(&refused)? {
                        if !private_files::receipt(&refused, &old_bytes) {
                            return Err(());
                        }
                    } else if !observed(&old.version)? {
                        return Err(());
                    }
                }
                private_files::remove_exact(&gate, &old_bytes).map_err(|_| ())?;
            }
            if exists(&record_path(&directory, &request_id, "attempt"))?
                || !current(host, origin, owner)
            {
                return Err(());
            }
            private_files::create(&gate, &encoded).map_err(|_| ())?;
            private_files::create(&record_path(&directory, &request_id, "attempt"), &encoded)
                .map_err(|_| ())?;
            if !host.shutdown_generation(origin, owner) {
                return Err(());
            }
            // The SDK re-verifies signature and signed version before staging its NSIS installer.
            // Windows exits on successful installer launch. No success receipt is fabricated here.
            if cache.update.install(bytes).is_err() {
                // Pinned 2.14.1 exits immediately after a successful Windows ShellExecuteW.
                // A returned error therefore proves no installer launch; failure to save this
                // private terminal record preserves the original unknown hold.
                let _ = private_files::create(
                    &record_path(&directory, &request_id, "not-launched"),
                    &encoded,
                );
            }
            app.exit(1);
            Ok(result(
                context,
                "install-unknown",
                Some(&request_id),
                Some(&prepared.version),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn broker_refuses_transport_keys_paths_and_extra_install_arguments() {
        for raw in [
            json!({"operation":"status","requestId":null}),
            json!({"operation":"check","requestId":"id"}),
            json!({"operation":"download","requestId":"id"}),
            json!({"operation":"install","requestId":"id"}),
        ] {
            assert!(serde_json::from_value::<Request>(raw).is_ok());
        }
        for raw in [
            json!({"operation":"install","requestId":"id","url":"https://foreign"}),
            json!({"operation":"check","requestId":"id","pubkey":"foreign"}),
            json!({"operation":"install","requestId":"id","args":["/S"]}),
            json!({"operation":"erase","requestId":"id"}),
        ] {
            assert!(serde_json::from_value::<Request>(raw).is_err());
        }
    }
    #[cfg(windows)]
    struct Scratch {
        base: PathBuf,
        context: RegistrationContext,
    }
    #[cfg(windows)]
    impl Scratch {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let base = std::env::temp_dir().join(format!(
                "forge-native-update-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir(&base).unwrap();
            let home = base.join("private-home");
            drop(private_files::directory(&home, true).unwrap());
            let command = base.join("hearth.exe");
            let context=RegistrationContext::from_ready(json!({"version":1,"root":base,"home":home,"command":command,"args":["--mcp-stdio","--root",base,"--home",home]}),&base,&command).unwrap();
            Self { base, context }
        }
        fn prepared(&self, version: &str) -> (String, Vec<u8>) {
            let directory = folder(&self.context);
            drop(private_files::directory(&directory, true).unwrap());
            drop(private_files::lease(&directory.join("update.lock"), true).unwrap());
            let id = "ad000000-0000-4000-8000-000000000001".to_owned();
            let value = Prepared {
                schema_version: 1,
                request_id: id.clone(),
                root: self.context.root.clone(),
                home: self.context.home.clone(),
                version: version.to_owned(),
                source_version: env!("CARGO_PKG_VERSION").to_owned(),
                package_sha256: "a".repeat(64),
                prepared_at: 1,
            };
            let bytes = serde_json::to_vec(&value).unwrap();
            private_files::create(&record_path(&directory, &id, "prepared"), &bytes).unwrap();
            (id, bytes)
        }
    }
    #[cfg(windows)]
    impl Drop for Scratch {
        fn drop(&mut self) {
            let actual = std::fs::canonicalize(&self.base).unwrap();
            let temp = std::fs::canonicalize(std::env::temp_dir()).unwrap();
            assert_eq!(actual.parent(), Some(temp.as_path()));
            assert!(actual
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("forge-native-update-"));
            std::fs::remove_dir_all(actual).unwrap();
        }
    }
    #[cfg(windows)]
    #[test]
    fn durable_original_distinguishes_not_launched_unknown_and_observed_without_replaying() {
        let scratch = Scratch::new();
        let (id, bytes) = scratch.prepared("99.0.0");
        let directory = folder(&scratch.context);
        let state = UpdateState::default();
        assert_eq!(
            status(&scratch.context, &state, Some(&id)).unwrap()["state"],
            "not-attempted"
        );
        private_files::create(&directory.join("installation-attempt.json"), &bytes).unwrap();
        private_files::create(&record_path(&directory, &id, "attempt"), &bytes).unwrap();
        assert_eq!(
            status(&scratch.context, &state, None).unwrap()["requestId"],
            id
        );
        assert_eq!(
            status(&scratch.context, &state, Some(&id)).unwrap()["state"],
            "install-unknown"
        );
        private_files::create(&record_path(&directory, &id, "not-launched"), &bytes).unwrap();
        assert_eq!(
            status(&scratch.context, &state, Some(&id)).unwrap()["state"],
            "not-attempted"
        );
        let held = private_files::lease(&directory.join("update.lock"), false).unwrap();
        assert!(status(&scratch.context, &state, Some(&id)).is_err());
        drop(held);
        let mut foreign = scratch.context.clone();
        foreign.root.push_str("-foreign");
        assert!(status(&foreign, &state, Some(&id)).is_err());
        assert!(status(
            &scratch.context,
            &state,
            Some("ad000000-0000-4000-8000-000000000002")
        )
        .is_err());
        assert!(private_files::receipt(
            &record_path(&directory, &id, "attempt"),
            &bytes
        ));
    }
    #[cfg(windows)]
    #[test]
    fn actual_running_version_observation_keeps_the_original_attempt_record() {
        let scratch = Scratch::new();
        let (id, bytes) = scratch.prepared(env!("CARGO_PKG_VERSION"));
        let directory = folder(&scratch.context);
        private_files::create(&record_path(&directory, &id, "attempt"), &bytes).unwrap();
        assert_eq!(
            status(&scratch.context, &UpdateState::default(), Some(&id)).unwrap()["state"],
            "version-observed"
        );
        assert!(private_files::receipt(
            &record_path(&directory, &id, "attempt"),
            &bytes
        ));
    }
}
