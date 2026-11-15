//! Private Windows consumer. All paths come from native context and fixed clients.
use super::valid_id;
use crate::config_publish::{self as publication, ReviewedFile};
use crate::config_transform::{self, Client, Proposal};
use crate::private_files;
use crate::registration_context::RegistrationContext;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
type Result<T> = std::result::Result<T, &'static str>;
const TTL: u64 = 120_000;
#[derive(Default)]
pub struct RegistrationState { reviews: HashMap<&'static str, Review>, terminal: HashMap<String,(Client,Value)> }
struct Review {
    client: Client, request_id: String, scope_key: String, owner: String,
    created_at: u64, expires_at: u64, target: PathBuf, original: Original,
    after: Vec<u8>, root_anchor: ReviewedFile,
}
enum Original { File(ReviewedFile), MissingParent(ReviewedFile) }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pending { schema_version: u8, client: Client, request_id: String, scope_key: String }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    schema_version: u8, client: Client, request_id: String, scope_key: String,
    root: String, home: String, command: String, args: Vec<String>, target: PathBuf,
    root_identity: String, original: Vec<u8>, original_exists: bool,
    after_sha256: String, audit_event_id: u64, created_at: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Authorization {
    schema_version: u8, client: Client, request_id: String, root: String, home: String,
    audit_event_id: u64, created_at: u64,
}
#[repr(C)]
struct Guid { first: u32, second: u16, third: u16, rest: [u8;8] }
#[link(name = "ole32")]
unsafe extern "system" { fn CoCreateGuid(guid: *mut Guid) -> i32; }
fn uuid() -> Result<String> {
    let mut guid = Guid { first:0, second:0, third:0, rest:[0;8] };
    if unsafe { CoCreateGuid(&mut guid) } < 0 { return Err("unavailable"); }
    Ok(format!("{:08x}-{:04x}-{:04x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",guid.first,guid.second,guid.third,guid.rest[0],guid.rest[1],guid.rest[2],guid.rest[3],guid.rest[4],guid.rest[5],guid.rest[6],guid.rest[7]))
}
fn now() -> Result<u64> {
    let value = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "unavailable")?.as_millis();
    if value > 9_007_199_254_740_991 { return Err("unavailable"); }
    Ok(value as u64)
}
fn name(client: Client) -> &'static str {
    match client { Client::Claude => "claude", Client::Codex => "codex", Client::Cursor => "cursor" }
}
fn hash(bytes: &[u8]) -> String { format!("{:x}",Sha256::digest(bytes)) }
fn disk_path(raw: &str) -> PathBuf { PathBuf::from(raw.strip_prefix(r"\\?\").unwrap_or(raw).replace('/', "\\")) }
#[derive(Default)]
struct ClientEnvironment { home: Option<String>, profile: Option<String>, claude: Option<String>, codex: Option<String> }
fn environment() -> Result<ClientEnvironment> {
    let read = |key| std::env::var_os(key).map(|v| v.into_string().map_err(|_| "unsupported")).transpose();
    Ok(ClientEnvironment { home:read("HOME")?,profile:read("USERPROFILE")?,claude:read("CLAUDE_CONFIG_DIR")?,codex:read("CODEX_HOME")? })
}
fn target(client: Client, profile: &Path, env: &ClientEnvironment) -> Result<PathBuf> {
    let spelling = |p:&Path| p.to_string_lossy().replace('/',"\\").trim_end_matches('\\').to_owned();
    for value in [&env.home,&env.profile].into_iter().flatten() {
        if value.is_empty() || spelling(Path::new(value)) != spelling(profile) { return Err("unsupported"); }
    }
    let overridden = |value:&Option<String>, default:PathBuf| -> Result<PathBuf> {
        match value { Some(value) if !value.is_empty() && Path::new(value).is_absolute() => Ok(disk_path(value)), Some(_) => Err("unsupported"), None => Ok(default) }
    };
    let path = match client {
        Client::Claude => overridden(&env.claude,profile.to_path_buf())?.join(".claude.json"),
        Client::Codex => overridden(&env.codex,profile.join(".codex"))?.join("config.toml"),
        Client::Cursor => profile.join(".cursor").join("mcp.json"),
    };
    if !path.is_absolute() { return Err("unsupported"); }
    Ok(path)
}
fn current_target(client: Client) -> Result<PathBuf> {
    target(client,&publication::os_user_profile().map_err(|_| "unsupported")?,&environment()?)
}
fn root_anchor(context: &RegistrationContext) -> Result<ReviewedFile> {
    let path = disk_path(&context.root).join(format!(".agent-forge-mcp-scope-{}",uuid()?));
    let anchor = publication::review(&path).map_err(|_| "unsupported")?;
    if anchor.exists() { return Err("unavailable"); }
    Ok(anchor)
}
fn scope(context: &RegistrationContext, client: Client, target: &Path, original: &[u8], exists: bool, root_identity: &str) -> String {
    hash(json!([context.root,context.home,context.command,context.args,client,target,hash(original),exists,root_identity]).to_string().as_bytes())
}
fn folder(context: &RegistrationContext, create: bool) -> Result<Option<(PathBuf,private_files::Directory,private_files::Directory)>> {
    let home = disk_path(&context.home);
    let home_guard = private_files::directory(&home,false).map_err(|_| "recovery-unavailable")?;
    let path = home.join("mcp-registrations");
    if !create {
        match std::fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("recovery-unavailable"),
            Ok(_) => {},
        }
    }
    let guard = private_files::directory(&path,create).map_err(|_| "recovery-unavailable")?;
    Ok(Some((path,home_guard,guard)))
}
fn pending_file(folder: &Path, client: Client) -> PathBuf { folder.join(format!("{}.pending.json",name(client))) }
fn original_file(folder: &Path, id: &str) -> PathBuf { folder.join(format!("{id}.original.json")) }
fn receipt_file(folder: &Path, id: &str) -> PathBuf { folder.join(format!("{id}.receipt.json")) }
fn attempt_file(folder: &Path, id: &str) -> PathBuf { folder.join(format!("{id}.attempted")) }
fn pending_bytes(pending: &Pending) -> Result<Vec<u8>> { serde_json::to_vec(pending).map_err(|_| "unavailable") }
fn read_pending(folder: &Path, client: Client) -> Result<Option<Pending>> {
    let file = pending_file(folder,client);
    match std::fs::symlink_metadata(&file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("recovery-unavailable"),
        Ok(_) => {},
    }
    let bytes = private_files::read(&file,8192).map_err(|_| "recovery-unavailable")?;
    let pending:Pending = serde_json::from_slice(&bytes).map_err(|_| "recovery-unavailable")?;
    if pending.schema_version != 1 || pending.client != client || !valid_id(&pending.request_id) || pending.scope_key.len()!=64 || !pending.scope_key.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return Err("recovery-unavailable"); }
    Ok(Some(pending))
}
fn read_journal(context: &RegistrationContext, folder: &Path, pending: &Pending) -> Result<Journal> {
    let bytes = private_files::read(&original_file(folder,&pending.request_id),6*1024*1024).map_err(|_| "recovery-unavailable")?;
    let journal:Journal = serde_json::from_slice(&bytes).map_err(|_| "recovery-unavailable")?;
    if journal.schema_version != 1 || journal.client != pending.client || journal.request_id != pending.request_id || journal.scope_key != pending.scope_key || journal.root != context.root || journal.home != context.home || journal.command != context.command || journal.args != context.args || journal.original.len()>1024*1024 || journal.after_sha256.len()!=64 || journal.audit_event_id == 0 || journal.audit_event_id>9_007_199_254_740_991 || journal.scope_key != scope(context,journal.client,&journal.target,&journal.original,journal.original_exists,&journal.root_identity) { return Err("scope-changed"); }
    if root_anchor(context)?.scope_identity() != journal.root_identity { return Err("scope-changed"); }
    Ok(journal)
}
fn receipt(journal: &Journal) -> Result<Vec<u8>> {
    serde_json::to_vec(&json!({"schemaVersion":1,"client":journal.client,"requestId":journal.request_id,"scopeKey":journal.scope_key,"afterSha256":journal.after_sha256,"auditEventId":journal.audit_event_id})).map_err(|_| "unavailable")
}
fn outcome(pending: &Pending, state: &str, reason: Option<&str>) -> Value {
    json!({"client":pending.client,"requestId":pending.request_id,"scopeKey":pending.scope_key,"state":state,"reason":reason})
}
fn clean_pending(folder: &Path, pending: &Pending) {
    if let Ok(bytes) = pending_bytes(pending) { let _ = private_files::remove_exact(&pending_file(folder,pending.client),&bytes); }
}
fn review_at(state: &mut RegistrationState, context: &RegistrationContext, owner: &str, client: Client, path: PathBuf) -> Result<Value> {
    if let Some((journal, _home_guard, _journal_guard)) = folder(context,false)? {
        if let Some(pending) = read_pending(&journal,client)? {
            let _lease = private_files::lease(&journal.join(format!("{}.lock",name(client))),false).map_err(|_| "busy")?;
            let original = read_journal(context,&journal,&pending)?;
            if terminal_outcome(&original,&journal,&pending)?["state"] == "unknown" {
                return Ok(json!({"state":"pending","client":client,"requestId":pending.request_id,"scopeKey":pending.scope_key}));
            }
        }
    }
    let id = uuid()?;
    let anchor = root_anchor(context)?;
    let original = match publication::review(&path) {
        Ok(file) => Original::File(file),
        Err(_) => {
            let parent = path.parent().ok_or("unsupported")?;
            if !std::fs::symlink_metadata(parent).is_err_and(|e| e.kind()==std::io::ErrorKind::NotFound) { return Err("unreadable"); }
            let absent = publication::review(parent).map_err(|_| "unsupported")?;
            if absent.exists() { return Err("scope-changed"); }
            Original::MissingParent(absent)
        }
    };
    let (bytes,exists) = match &original { Original::File(file) => (file.original(),file.exists()), Original::MissingParent(_) => (&[][..],false) };
    let scope_key = scope(context,client,&path,bytes,exists,&anchor.scope_identity());
    let proposal = config_transform::propose(client,bytes,exists,&context.command,&context.args).map_err(|e| match e {config_transform::Refusal::Foreign=>"foreign",config_transform::Refusal::Unreadable=>"unreadable",_=>"unsupported"})?;
    let created_at = now()?;
    let after = match proposal { Proposal::AlreadyConfigured => return Ok(json!({"state":"configured","client":client,"scopeKey":scope_key,"observedAt":created_at})), Proposal::Change(bytes)=>bytes };
    let expires_at = created_at.checked_add(TTL).ok_or("unavailable")?;
    state.reviews.insert(name(client),Review {client,request_id:id.clone(),scope_key:scope_key.clone(),owner:owner.to_owned(),created_at,expires_at,target:path,original,after,root_anchor:anchor});
    Ok(json!({"state":"review","client":client,"requestId":id,"scopeKey":scope_key,"expiresAt":expires_at}))
}
pub fn review(state: &mut RegistrationState, context: &RegistrationContext, owner: &str, client: Client) -> Result<Value> {
    review_at(state,context,owner,client,current_target(client)?)
}

fn exact_private(path: &Path, expected: &[u8]) -> bool {
    private_files::read(path,8192).is_ok_and(|bytes| bytes==expected)
}
fn not_attempted_file(folder: &Path, id: &str) -> PathBuf { folder.join(format!("{id}.not-attempted")) }
fn fence_bytes(journal: &Journal) -> Result<Vec<u8>> {
    Ok(format!("mcp-registration-v1:{}\n",hash(&receipt(journal)?)).into_bytes())
}
fn terminal_outcome(journal: &Journal, folder: &Path, pending: &Pending) -> Result<Value> {
    let expected = receipt(journal)?;
    if private_files::receipt(&receipt_file(folder,&pending.request_id),&expected) {
        return Ok(outcome(pending,"confirmed",None));
    }
    let fence = fence_bytes(journal)?;
    if exact_private(&not_attempted_file(folder,&pending.request_id),&fence) {
        return Ok(outcome(pending,"not-attempted",Some("cancelled")));
    }
    // This is the original durable prepared journal, not a missing receipt.
    // Every commit call must first durably create the attempt fence. A missing
    // fence with no in-flight native operation proves this request was not sent.
    let attempted = attempt_file(folder,&pending.request_id);
    if std::fs::symlink_metadata(&attempted).is_err_and(|e| e.kind()==std::io::ErrorKind::NotFound) {
        return Ok(outcome(pending,"not-attempted",Some("cancelled")));
    }
    Ok(outcome(pending,"unknown",Some(if exact_private(&attempted,&fence) { "unavailable" } else { "recovery-unavailable" })))
}
fn read_journal_id(context: &RegistrationContext, folder: &Path, id: &str) -> Result<(Journal,Pending)> {
    let bytes = private_files::read(&original_file(folder,id),6*1024*1024).map_err(|_| "recovery-unavailable")?;
    let raw:Journal = serde_json::from_slice(&bytes).map_err(|_| "recovery-unavailable")?;
    let pending = Pending {schema_version:1,client:raw.client,request_id:id.to_owned(),scope_key:raw.scope_key};
    let journal = read_journal(context,folder,&pending)?;
    Ok((journal,pending))
}
fn authorization(context: &RegistrationContext, review: &Review) -> Result<u64> {
    let home = disk_path(&context.home);
    let _home = private_files::directory(&home,false).map_err(|_| "authorization-unavailable")?;
    let folder = home.join("mcp-authorizations");
    let _folder = private_files::directory(&folder,false).map_err(|_| "authorization-unavailable")?;
    let bytes = private_files::read(&folder.join(format!("{}.json",name(review.client))),8192).map_err(|_| "authorization-unavailable")?;
    let ticket:Authorization = serde_json::from_slice(&bytes).map_err(|_| "authorization-unavailable")?;
    let current = now()?;
    if ticket.schema_version != 1 || ticket.client != review.client || ticket.request_id != review.request_id || ticket.root != context.root || ticket.home != context.home || ticket.audit_event_id == 0 || ticket.audit_event_id > 9_007_199_254_740_991 || ticket.created_at < review.created_at || ticket.created_at > current || current-ticket.created_at >= TTL {
        return Err("authorization-unavailable");
    }
    Ok(ticket.audit_event_id)
}
fn remember(state: &mut RegistrationState, client: Client, id: &str, value: &Value) {
    state.terminal.retain(|_,(previous,_)| *previous!=client);
    state.terminal.insert(id.to_owned(),(client,value.clone()));
}
fn commit_at(state: &mut RegistrationState, context: &RegistrationContext, owner: &str, id: &str, current: impl Fn()->bool, target_current: impl Fn(Client,&Path)->bool) -> Result<Value> {
    let key = state.reviews.iter().find(|(_,r)| r.request_id==id).map(|(key,_)| *key).ok_or("expired")?;
    let review = state.reviews.remove(key).ok_or("expired")?;
    let pending = Pending {schema_version:1,client:review.client,request_id:id.to_owned(),scope_key:review.scope_key.clone()};
    let mut attempted = false;
    let mut durable = false;
    let mut stored_journal:Option<Journal> = None;
    let result = (|| {
        let time = now()?;
        if review.owner != owner || !current() || !target_current(review.client,&review.target) { return Err("scope-changed"); }
        if time < review.created_at || time >= review.expires_at { return Err("expired"); }
        let audit_event_id = authorization(context,&review)?;
        let root_probe = disk_path(&context.root).join(".agent-forge-mcp-scope-pin");
        let _root_pins = publication::pin_path(&root_probe).map_err(|_| "scope-changed")?;
        if !review.root_anchor.parent_chain_matches() || !current() { return Err("scope-changed"); }
        let Some((journal_dir,_home_guard,_journal_guard)) = folder(context,true)? else { return Err("recovery-unavailable"); };
        let _lease = private_files::lease(&journal_dir.join(format!("{}.lock",name(review.client))),true).map_err(|_| "busy")?;
        if let Some(old) = read_pending(&journal_dir,review.client)? {
            let old_journal = read_journal(context,&journal_dir,&old)?;
            if terminal_outcome(&old_journal,&journal_dir,&old)?["state"] == "unknown" { return Err("busy"); }
            private_files::remove_exact(&pending_file(&journal_dir,old.client),&pending_bytes(&old)?).map_err(|_| "recovery-unavailable")?;
        }
        let (original,original_exists) = match &review.original { Original::File(file)=>(file.original().to_vec(),file.exists()),Original::MissingParent(_)=>(Vec::new(),false) };
        let journal = Journal {schema_version:1,client:review.client,request_id:id.to_owned(),scope_key:review.scope_key.clone(),root:context.root.clone(),home:context.home.clone(),command:context.command.clone(),args:context.args.clone(),target:review.target.clone(),root_identity:review.root_anchor.scope_identity(),original,original_exists,after_sha256:hash(&review.after),audit_event_id,created_at:time};
        let bytes = serde_json::to_vec(&journal).map_err(|_| "recovery-unavailable")?;
        private_files::create(&original_file(&journal_dir,id),&bytes).map_err(|_| "recovery-unavailable")?;
        private_files::create(&pending_file(&journal_dir,review.client),&pending_bytes(&pending)?).map_err(|_| "recovery-unavailable")?;
        durable = true;
        let expected_receipt = receipt(&journal)?;
        let fence = fence_bytes(&journal)?;
        stored_journal = Some(journal);
        let mut parent_guard = None;
        let mut parent_pins = None;
        let original = match review.original {
            Original::File(file)=>file,
            Original::MissingParent(absent)=>{
                let parent = review.target.parent().ok_or("unsupported")?;
                parent_pins = Some(publication::pin_path(parent).map_err(|_| "scope-changed")?);
                if !absent.parent_chain_matches() { return Err("scope-changed"); }
                parent_guard = Some(private_files::directory(parent,true).map_err(|_| "unsupported")?);
                let file = publication::review(&review.target).map_err(|_| "unreadable")?;
                if file.exists() { return Err("scope-changed"); }
                file
            }
        };
        if !current() || now()? >= review.expires_at { return Err("expired"); }
        let receipt_path = receipt_file(&journal_dir,id);
        let receipt_original = publication::review(&receipt_path).map_err(|_| "recovery-unavailable")?;
        let security = private_files::creation_security().map_err(|_| "recovery-unavailable")?;
        let prepared = publication::prepare_private(original,&review.after,receipt_original,&expected_receipt,&security).map_err(|e| match e {publication::Refusal::Changed=>"scope-changed",publication::Refusal::Unsupported=>"unsupported",_=>"unavailable"})?;
        if !current() || now()? >= review.expires_at { drop(prepared); return Err("scope-changed"); }
        private_files::create(&attempt_file(&journal_dir,id),&fence).map_err(|_| "recovery-unavailable")?;
        if !current() { drop(prepared); return Err("scope-changed"); }
        attempted = true;
        let native_outcome = prepared.commit();
        let confirmed = native_outcome == publication::Outcome::Confirmed && private_files::receipt(&receipt_path,&expected_receipt);
        drop((parent_guard,parent_pins));
        if confirmed { clean_pending(&journal_dir,&pending); Ok(outcome(&pending,"confirmed",None)) }
        else { Ok(outcome(&pending,"unknown",Some("unavailable"))) }
    })();
    match result {
        Ok(value)=>Ok(value),
        Err(reason) if attempted=>Ok(outcome(&pending,"unknown",Some(reason))),
        Err(reason)=>{
            let value = outcome(&pending,"not-attempted",Some(reason));
            remember(state,review.client,id,&value);
            if durable {
                if let (Some(journal),Ok(Some((folder,_home,_guard)))) = (stored_journal,folder(context,false)) {
                    if let Ok(fence) = fence_bytes(&journal) {
                        if private_files::create(&not_attempted_file(&folder,id),&fence).is_ok() { clean_pending(&folder,&pending); }
                    }
                }
            }
            Ok(value)
        }
    }
}
pub fn commit(state: &mut RegistrationState, context: &RegistrationContext, owner: &str, id: &str, current: impl Fn()->bool) -> Result<Value> {
    commit_at(state,context,owner,id,current,|client,path| current_target(client).is_ok_and(|target| target.as_path()==path))
}
pub fn recover(state: &mut RegistrationState, context: &RegistrationContext, id: &str) -> Result<Value> {
    if let Some((_,value)) = state.terminal.get(id) { return Ok(value.clone()); }
    if let Some(key) = state.reviews.iter().find(|(_,r)| r.request_id==id).map(|(key,_)| *key) {
        let review = state.reviews.remove(key).ok_or("recovery-unavailable")?;
        let pending = Pending {schema_version:1,client:review.client,request_id:id.to_owned(),scope_key:review.scope_key};
        let value = outcome(&pending,"not-attempted",Some("cancelled"));
        remember(state,review.client,id,&value);
        return Ok(value);
    }
    let Some((folder,_home,_guard)) = folder(context,false)? else { return Err("recovery-unavailable"); };
    let (journal,pending) = read_journal_id(context,&folder,id)?;
    let _lease = private_files::lease(&folder.join(format!("{}.lock",name(pending.client))),false).map_err(|_| "busy")?;
    terminal_outcome(&journal,&folder,&pending)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture { base: PathBuf, context: RegistrationContext, profile: PathBuf }
    impl Fixture {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let base = std::env::temp_dir().join(format!("forge-mcp-registration-{}-{nonce}",std::process::id()));
            std::fs::create_dir(&base).unwrap();
            let home = base.join("private-home");
            drop(private_files::directory(&home,true).unwrap());
            let profile = base.join("profile");
            drop(private_files::directory(&profile,true).unwrap());
            let command = base.join("hearth.exe");
            std::fs::write(&command,b"asset fixture only, never executed").unwrap();
            let raw = json!({"version":1,"root":base,"home":home,"command":command,"args":["--mcp-stdio","--root",base,"--home",home]});
            let context = RegistrationContext::from_ready(raw,&base,&command).unwrap();
            Self {base,context,profile}
        }
        fn path(&self, client: Client) -> PathBuf { target(client,&self.profile,&ClientEnvironment::default()).unwrap() }
        fn authorize(&self, client: Client, id: &str) {
            let folder = disk_path(&self.context.home).join("mcp-authorizations");
            drop(private_files::directory(&folder,true).unwrap());
            private_files::create(&folder.join(format!("{}.json",name(client))),&serde_json::to_vec(&json!({"schemaVersion":1,"client":client,"requestId":id,"root":self.context.root,"home":self.context.home,"auditEventId":42,"createdAt":now().unwrap()})).unwrap()).unwrap();
        }
        fn reviewed(&self, state: &mut RegistrationState, client: Client) -> String {
            let result = review_at(state,&self.context,"owner",client,self.path(client)).unwrap();
            assert_eq!(result["state"],"review");
            result["requestId"].as_str().unwrap().to_owned()
        }
        fn commit(&self, state: &mut RegistrationState, id: &str) -> Value {
            commit_at(state,&self.context,"owner",id,||true,|client,path|path==self.path(client).as_path()).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let actual = std::fs::canonicalize(&self.base).unwrap();
            let temporary = std::fs::canonicalize(std::env::temp_dir()).unwrap();
            assert_eq!(actual.parent(),Some(temporary.as_path()));
            assert!(actual.file_name().unwrap().to_string_lossy().starts_with("forge-mcp-registration-"));
            std::fs::remove_dir_all(actual).unwrap();
        }
    }
    #[test]
    fn fixed_default_and_override_targets_never_fall_back_from_ambiguous_input() {
        let profile = Path::new(r"C:\Users\Example");
        let empty = ClientEnvironment::default();
        assert_eq!(target(Client::Claude,profile,&empty).unwrap(),profile.join(".claude.json"));
        assert_eq!(target(Client::Codex,profile,&empty).unwrap(),profile.join(".codex/config.toml"));
        assert_eq!(target(Client::Cursor,profile,&empty).unwrap(),profile.join(".cursor/mcp.json"));
        let overrides = ClientEnvironment {claude:Some(r"C:\Claude Profile".to_owned()),codex:Some(r"C:\Codex Profile".to_owned()),..ClientEnvironment::default()};
        assert_eq!(target(Client::Claude,profile,&overrides).unwrap(),Path::new(r"C:\Claude Profile").join(".claude.json"));
        assert_eq!(target(Client::Codex,profile,&overrides).unwrap(),Path::new(r"C:\Codex Profile").join("config.toml"));
        for bad in ["", "relative", "https://foreign"] {
            let env = ClientEnvironment {codex:Some(bad.to_owned()),..ClientEnvironment::default()};
            assert!(target(Client::Codex,profile,&env).is_err());
        }
        let foreign = ClientEnvironment {home:Some(r"C:\Other User".to_owned()),..ClientEnvironment::default()};
        assert!(target(Client::Cursor,profile,&foreign).is_err());
    }
    #[test]
    fn original_is_private_and_exact_before_one_atomic_config_and_private_receipt() {
        let fixture = Fixture::new();
        let config = fixture.path(Client::Claude);
        let original = br#"{ "secret": "PRIVATE_CONFIG", "other": [1,2] }"#;
        std::fs::write(&config,original).unwrap();
        let mut state = RegistrationState::default();
        let id = fixture.reviewed(&mut state,Client::Claude);
        fixture.authorize(Client::Claude,&id);
        let saw_private_original = std::cell::Cell::new(false);
        let original_path = disk_path(&fixture.context.home).join("mcp-registrations").join(format!("{id}.original.json"));
        let outcome = commit_at(&mut state,&fixture.context,"owner",&id,|| {
            if original_path.exists() {
                let bytes = private_files::read(&original_path,6*1024*1024).unwrap();
                let journal:Journal = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(journal.original,original);
                assert_eq!(std::fs::read(&config).unwrap(),original);
                saw_private_original.set(true);
            }
            true
        },|client,path|path==fixture.path(client).as_path()).unwrap();
        assert!(saw_private_original.get());
        assert_eq!(outcome["state"],"confirmed");
        assert!(!outcome.to_string().contains("PRIVATE_CONFIG"));
        let Some((folder,_home,_guard)) = folder(&fixture.context,false).unwrap() else {panic!("missing journal")};
        let (journal,pending) = read_journal_id(&fixture.context,&folder,&id).unwrap();
        assert_eq!(journal.original,original);
        assert!(private_files::read(&original_file(&folder,&id),6*1024*1024).is_ok());
        assert!(private_files::receipt(&receipt_file(&folder,&id),&receipt(&journal).unwrap()));
        assert!(read_pending(&folder,Client::Claude).unwrap().is_none());
        assert_eq!(pending.request_id,id);
        let after = std::fs::read(&config).unwrap();
        assert!(after.starts_with(br#"{ "secret": "PRIVATE_CONFIG", "other": [1,2] "#));
        assert!(commit_at(&mut state,&fixture.context,"owner",&id,||true,|_,_|true).is_err());
        assert_eq!(std::fs::read(&config).unwrap(),after);
    }
    #[test]
    fn discarded_ack_recovers_exact_original_across_native_state_reload_without_resending() {
        let fixture = Fixture::new();
        let mut state = RegistrationState::default();
        let id = fixture.reviewed(&mut state,Client::Codex);
        fixture.authorize(Client::Codex,&id);
        let _lost = fixture.commit(&mut state,&id);
        let before = std::fs::read(fixture.path(Client::Codex)).unwrap();
        let recovered = recover(&mut RegistrationState::default(),&fixture.context,&id).unwrap();
        assert_eq!(recovered["state"],"confirmed");
        assert_eq!(recovered["requestId"],id);
        assert_eq!(std::fs::read(fixture.path(Client::Codex)).unwrap(),before);
        assert!(recover(&mut RegistrationState::default(),&fixture.context,"ad000000-0000-4000-8000-000000000001").is_err());
    }
    #[test]
    fn stale_client_edit_survives_and_an_exact_no_effect_receipt_recovers() {
        let fixture = Fixture::new();
        let config = fixture.path(Client::Claude);
        std::fs::write(&config,b"{}").unwrap();
        let mut state = RegistrationState::default();
        let id = fixture.reviewed(&mut state,Client::Claude);
        fixture.authorize(Client::Claude,&id);
        std::fs::write(&config,b"{\"foreign\":true}").unwrap();
        let result = fixture.commit(&mut state,&id);
        assert_eq!(result["state"],"not-attempted");
        assert_eq!(result["reason"],"scope-changed");
        assert_eq!(std::fs::read(&config).unwrap(),b"{\"foreign\":true}");
        assert_eq!(recover(&mut RegistrationState::default(),&fixture.context,&id).unwrap()["state"],"not-attempted");
    }
    #[test]
    fn exact_recovery_refuses_a_held_cross_process_lease() {
        let fixture = Fixture::new();
        let mut state = RegistrationState::default();
        let id = fixture.reviewed(&mut state,Client::Claude);
        fixture.authorize(Client::Claude,&id);
        assert_eq!(fixture.commit(&mut state,&id)["state"],"confirmed");
        let Some((folder,_home,_guard)) = folder(&fixture.context,false).unwrap() else {panic!("missing journal")};
        let lease = private_files::lease(&folder.join("claude.lock"),false).unwrap();
        assert!(private_files::lease(&folder.join("claude.lock"),false).is_err());
        assert_eq!(recover(&mut RegistrationState::default(),&fixture.context,&id).unwrap_err(),"busy");
        drop(lease);
        assert_eq!(recover(&mut RegistrationState::default(),&fixture.context,&id).unwrap()["state"],"confirmed");
    }
    #[test]
    fn attempted_without_receipt_stays_unknown_and_cannot_be_resubmitted() {
        let fixture = Fixture::new();
        let mut state = RegistrationState::default();
        let old = fixture.reviewed(&mut state,Client::Claude);
        fixture.authorize(Client::Claude,&old);
        assert_eq!(fixture.commit(&mut state,&old)["state"],"confirmed");
        let Some((folder,_home,_guard)) = folder(&fixture.context,false).unwrap() else {panic!("missing journal")};
        let (mut journal,_) = read_journal_id(&fixture.context,&folder,&old).unwrap();
        let id = uuid().unwrap(); journal.request_id = id.clone();
        let pending = Pending {schema_version:1,client:Client::Claude,request_id:id.clone(),scope_key:journal.scope_key.clone()};
        private_files::create(&original_file(&folder,&id),&serde_json::to_vec(&journal).unwrap()).unwrap();
        private_files::create(&pending_file(&folder,Client::Claude),&pending_bytes(&pending).unwrap()).unwrap();
        private_files::create(&attempt_file(&folder,&id),&fence_bytes(&journal).unwrap()).unwrap();
        let before = std::fs::read(fixture.path(Client::Claude)).unwrap();
        let result = recover(&mut RegistrationState::default(),&fixture.context,&id).unwrap();
        assert_eq!(result["state"],"unknown");
        let mut reload = RegistrationState::default();
        let reviewed = review_at(&mut reload,&fixture.context,"owner",Client::Claude,fixture.path(Client::Claude)).unwrap();
        assert_eq!(reviewed["state"],"pending"); assert_eq!(reviewed["requestId"],id);
        assert!(commit_at(&mut reload,&fixture.context,"owner",&id,||true,|_,_|true).is_err());
        assert_eq!(std::fs::read(fixture.path(Client::Claude)).unwrap(),before);
        assert!(read_pending(&folder,Client::Claude).unwrap().is_some());
        assert!(!receipt_file(&folder,&id).exists());
    }
    #[test]
    fn durable_prepared_original_without_attempt_fence_recovers_without_writing() {
        let fixture = Fixture::new();
        let mut state = RegistrationState::default();
        let old = fixture.reviewed(&mut state,Client::Claude);
        fixture.authorize(Client::Claude,&old);
        assert_eq!(fixture.commit(&mut state,&old)["state"],"confirmed");
        let Some((folder,_home,_guard)) = folder(&fixture.context,false).unwrap() else {panic!("missing journal")};
        let (mut journal,_) = read_journal_id(&fixture.context,&folder,&old).unwrap();
        let id = uuid().unwrap(); journal.request_id = id.clone();
        private_files::create(&original_file(&folder,&id),&serde_json::to_vec(&journal).unwrap()).unwrap();
        let before = std::fs::read(fixture.path(Client::Claude)).unwrap();
        assert_eq!(recover(&mut RegistrationState::default(),&fixture.context,&id).unwrap()["state"],"not-attempted");
        assert!(!attempt_file(&folder,&id).exists()); assert!(!receipt_file(&folder,&id).exists());
        assert_eq!(std::fs::read(fixture.path(Client::Claude)).unwrap(),before);
    }
    #[test]
    fn expired_or_retired_review_is_revoked_before_configuration_publication() {
        for expired in [true,false] {
            let fixture = Fixture::new(); let mut state = RegistrationState::default();
            let id = fixture.reviewed(&mut state,Client::Claude);
            fixture.authorize(Client::Claude,&id);
            if expired { state.reviews.get_mut("claude").unwrap().expires_at = 0; }
            let value = commit_at(&mut state,&fixture.context,if expired {"owner"} else {"retired"},&id,||true,|_,_|true).unwrap();
            assert_eq!(value["state"],"not-attempted");
            assert!(!fixture.path(Client::Claude).exists());
            assert_eq!(recover(&mut state,&fixture.context,&id).unwrap()["state"],"not-attempted");
        }
    }

    #[test]
    fn a_native_review_without_a_confirmed_operator_ticket_cannot_publish() {
        let fixture = Fixture::new(); let mut state = RegistrationState::default();
        let id = fixture.reviewed(&mut state,Client::Claude);
        let result = fixture.commit(&mut state,&id);
        assert_eq!(result["state"],"not-attempted");
        assert_eq!(result["reason"],"authorization-unavailable");
        assert!(!fixture.path(Client::Claude).exists());
        assert_eq!(recover(&mut state,&fixture.context,&id).unwrap()["state"],"not-attempted");
    }
    #[test]
    fn a_late_file_in_a_previously_missing_client_folder_is_preserved() {
        let fixture = Fixture::new(); let mut state = RegistrationState::default();
        let id = fixture.reviewed(&mut state,Client::Cursor);
        assert!(!fixture.profile.join(".cursor").exists());
        fixture.authorize(Client::Cursor,&id);
        drop(private_files::directory(&fixture.profile.join(".cursor"),true).unwrap());
        std::fs::write(fixture.path(Client::Cursor),b"{\"foreign\":true}").unwrap();
        assert_eq!(fixture.commit(&mut state,&id)["state"],"not-attempted");
        assert_eq!(std::fs::read(fixture.path(Client::Cursor)).unwrap(),b"{\"foreign\":true}");
    }

}
