//! Private source producer. Not exposed as a renderer command or wired to client configs.
//! TxF has no nontransactional fallback. See docs/mcp-conditional-publication.md.
#![allow(dead_code)]
use std::ffi::c_void;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Component, Path, PathBuf, Prefix};
use std::ptr::{null, null_mut};

const MAX_BYTES: usize = 1024 * 1024;
const OPEN_REPARSE: u32 = 0x00200000;
const BACKUP: u32 = 0x02000000;
const READ: u32 = 0x80000000;
const WRITE: u32 = 0x40000000;
const UNSUPPORTED: u32 = 0x400 | 0x4000 | 0x1000 | 0x400000;
type RawHandle = *mut c_void;
#[repr(C)]
#[derive(Default)]
struct FileInfo {
    attributes: u32,
    times: [u32; 6],
    volume: u32,
    size_high: u32,
    size_low: u32,
    links: u32,
    index_high: u32,
    index_low: u32,
}
#[repr(C)]
struct Guid(u32, u16, u16, [u8; 8]);
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateFileW(path: *const u16, access: u32, share: u32, security: *const c_void, disposition: u32, flags: u32, template: RawHandle) -> RawHandle;
    fn CreateFileTransactedW(path: *const u16, access: u32, share: u32, security: *const c_void, disposition: u32, flags: u32, template: RawHandle, transaction: RawHandle, mini_version: *const u16, extended: *const c_void) -> RawHandle;
    fn GetFileInformationByHandle(file: RawHandle, info: *mut FileInfo) -> i32;
    fn GetVolumeInformationW(root: *const u16, name: *mut u16, name_size: u32, serial: *mut u32, max_component: *mut u32, flags: *mut u32, fs_name: *mut u16, fs_size: u32) -> i32;
    fn GetDriveTypeW(root: *const u16) -> u32;
    fn CloseHandle(handle: RawHandle) -> i32;
}
#[link(name = "ktmw32")]
unsafe extern "system" {
    fn CreateTransaction(security: *const c_void, unit: *const c_void, options: u32, isolation: u32, flags: u32, timeout: u32, description: *const u16) -> RawHandle;
    fn CommitTransaction(transaction: RawHandle) -> i32;
}
#[link(name = "shell32")]
unsafe extern "system" {
    fn SHGetKnownFolderPath(id: *const Guid, flags: u32, token: RawHandle, path: *mut *mut u16) -> i32;
}
#[link(name = "ole32")]
unsafe extern "system" {
    fn CoTaskMemFree(memory: *mut c_void);
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal { Unsupported, Unavailable, Changed, TooLarge, ReceiptExists }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome { Confirmed, AttemptedUnknown }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Identity { volume: u32, index: u64 }
struct Transaction(RawHandle);
impl Drop for Transaction {
    fn drop(&mut self) { unsafe { CloseHandle(self.0); } }
}
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
fn checked_path(path: &Path) -> Result<(), Refusal> {
    let text = path.to_str().ok_or(Refusal::Unsupported)?;
    if text.encode_utf16().count() > 240 || text.contains('/') { return Err(Refusal::Unsupported); }
    let mut parts = path.components();
    if !matches!(parts.next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_))) || !matches!(parts.next(), Some(Component::RootDir)) { return Err(Refusal::Unsupported); }
    let mut count = 0;
    for part in parts {
        let Component::Normal(name) = part else { return Err(Refusal::Unsupported); };
        let name = name.to_str().ok_or(Refusal::Unsupported)?;
        if name.ends_with([' ', '.']) || name.chars().any(|c| c.is_control() || "<>:\"|?*".contains(c)) { return Err(Refusal::Unsupported); }
        count += 1;
    }
    if count == 0 { return Err(Refusal::Unsupported); }
    Ok(())
}
fn identity(file: &File, directory: bool) -> Result<Identity, Refusal> {
    let mut info = FileInfo::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 { return Err(Refusal::Unavailable); }
    if info.attributes & UNSUPPORTED != 0 || (info.attributes & 0x10 != 0) != directory || (!directory && info.links != 1) { return Err(Refusal::Unsupported); }
    Ok(Identity { volume: info.volume, index: (u64::from(info.index_high) << 32) | u64::from(info.index_low) })
}
fn file_from(handle: RawHandle) -> Result<File, Refusal> {
    if handle == (-1isize as RawHandle) || handle.is_null() { return Err(Refusal::Unavailable); }
    Ok(unsafe { File::from_raw_handle(handle) })
}
fn normal_open(path: &Path, directory: bool) -> Result<File, Refusal> {
    let access = if directory { 0x80 } else { READ };
    // Parent handles deny DELETE through commit. A review read denies WRITE.
    let share = if directory { 3 } else { 5 };
    let flags = OPEN_REPARSE | if directory { BACKUP } else { 0 };
    file_from(unsafe { CreateFileW(wide(path).as_ptr(), access, share, null(), 3, flags, null_mut()) })
}
fn pin_parents(path: &Path) -> Result<(Vec<File>, Vec<Identity>), Refusal> {
    checked_path(path)?;
    let ancestors: Vec<_> = path.ancestors().skip(1).collect();
    let root = ancestors.last().ok_or(Refusal::Unsupported)?;
    if unsafe { GetDriveTypeW(wide(root).as_ptr()) } != 3 { return Err(Refusal::Unsupported); }
    let mut fs = [0u16; 32];
    if unsafe { GetVolumeInformationW(wide(root).as_ptr(), null_mut(), 0, null_mut(), null_mut(), null_mut(), fs.as_mut_ptr(), fs.len() as u32) } == 0 || fs[..5] != [78, 84, 70, 83, 0] { return Err(Refusal::Unsupported); }
    let mut files = Vec::new();
    let mut identities = Vec::new();
    for parent in ancestors.into_iter().rev() {
        let file = normal_open(parent, true)?;
        identities.push(identity(&file, true)?);
        files.push(file);
    }
    Ok((files, identities))
}
fn read_bytes(file: &mut File) -> Result<Vec<u8>, Refusal> {
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes).map_err(|_| Refusal::Unavailable)?;
    if bytes.len() > MAX_BYTES { return Err(Refusal::TooLarge); }
    Ok(bytes)
}
/// No raw bytes, paths or OS errors from this private snapshot may enter a renderer response.
pub struct ReviewedFile { path: PathBuf, parents: Vec<Identity>, file: Option<Identity>, bytes: Vec<u8> }
pub fn review(path: &Path) -> Result<ReviewedFile, Refusal> {
    let (_pins, parents) = pin_parents(path)?;
    let (file, bytes) = match normal_open(path, false) {
        Ok(mut file) => (Some(identity(&file, false)?), read_bytes(&mut file)?),
        Err(_) if std::fs::symlink_metadata(path).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound) => (None, Vec::new()),
        Err(error) => return Err(error),
    };
    Ok(ReviewedFile { path: path.to_path_buf(), parents, file, bytes })
}
fn transacted_open(path: &Path, transaction: &Transaction, create: bool) -> Result<File, Refusal> {
    file_from(unsafe { CreateFileTransactedW(wide(path).as_ptr(), READ | WRITE, 7, null(), if create { 1 } else { 3 }, OPEN_REPARSE | 0x80000000, null_mut(), transaction.0, null(), null()) })
}
/// Preparing changes only the isolated transaction view. The original and receipt are
/// published together by commit. Dropping this value closes the last transaction handle.
pub struct PendingPublication { transaction: Transaction, _parents: Vec<File>, receipt: PathBuf, receipt_bytes: Vec<u8> }
/// Caller must first durably audit the exact reviewed original under an owner-private
/// home, and supply a create-only receipt there. This API is not a renderer boundary.
pub fn prepare(reviewed: ReviewedFile, after: &[u8], receipt: ReviewedFile, receipt_bytes: &[u8]) -> Result<PendingPublication, Refusal> {
    if after.len() > MAX_BYTES || receipt_bytes.is_empty() || receipt_bytes.len() > 8192 { return Err(Refusal::TooLarge); }
    if receipt.file.is_some() { return Err(Refusal::ReceiptExists); }
    let (mut pins, parents) = pin_parents(&reviewed.path)?;
    let (receipt_pins, receipt_parents) = pin_parents(&receipt.path)?;
    if parents != reviewed.parents || receipt_parents != receipt.parents || parents.first().map(|p| p.volume) != receipt_parents.first().map(|p| p.volume) { return Err(Refusal::Changed); }
    pins.extend(receipt_pins);
    let handle = unsafe { CreateTransaction(null(), null(), 0, 0, 0, 5000, null()) };
    if handle == (-1isize as RawHandle) || handle.is_null() { return Err(Refusal::Unsupported); }
    let transaction = Transaction(handle);
    {
        let mut file = transacted_open(&reviewed.path, &transaction, reviewed.file.is_none())?;
        let actual_id = identity(&file, false)?;
        if reviewed.file.is_some_and(|id| id != actual_id) || read_bytes(&mut file)? != reviewed.bytes { return Err(Refusal::Changed); }
        // These are private TxF copy-on-write operations, never ordinary truncation.
        file.seek(SeekFrom::Start(0)).map_err(|_| Refusal::Unavailable)?;
        file.write_all(after).map_err(|_| Refusal::Unavailable)?;
        file.set_len(after.len() as u64).map_err(|_| Refusal::Unavailable)?;
        let mut receipt_file = transacted_open(&receipt.path, &transaction, true).map_err(|_| Refusal::ReceiptExists)?;
        identity(&receipt_file, false)?;
        receipt_file.write_all(receipt_bytes).map_err(|_| Refusal::Unavailable)?;
    }
    // Every transacted file handle has closed. TxF isolation remains until commit/rollback.
    Ok(PendingPublication { transaction, _parents: pins, receipt: receipt.path, receipt_bytes: receipt_bytes.to_vec() })
}
impl PendingPublication {
    pub fn commit(self) -> Outcome {
        if unsafe { CommitTransaction(self.transaction.0) } == 0 { return Outcome::AttemptedUnknown; }
        if receipt_matches(&self.receipt, &self.receipt_bytes) { Outcome::Confirmed } else { Outcome::AttemptedUnknown }
    }
}
/// A matching durable receipt proves an earlier publication. An absent receipt never
/// authorizes retry; consumer must retain its attempted/unknown journal state.
pub fn receipt_matches(path: &Path, expected: &[u8]) -> bool {
    !expected.is_empty() && expected.len() <= 8192 && review(path).is_ok_and(|r| r.file.is_some() && r.bytes == expected)
}
/// Windows' current-user profile, independent of HOME/USERPROFILE environment overrides.
pub fn os_user_profile() -> Result<PathBuf, Refusal> {
    let id = Guid(0x5e6c858f, 0x0e22, 0x4760, [0x9a, 0xfe, 0xea, 0x33, 0x17, 0xb6, 0x71, 0x73]);
    let mut raw = null_mut();
    let status = unsafe { SHGetKnownFolderPath(&id, 0, null_mut(), &mut raw) };
    if status < 0 || raw.is_null() {
        if !raw.is_null() { unsafe { CoTaskMemFree(raw.cast()); } }
        return Err(Refusal::Unavailable);
    }
    let result = (|| {
        let mut length = 0;
        while length <= 240 && unsafe { *raw.add(length) } != 0 { length += 1; }
        if length > 240 { return Err(Refusal::Unsupported); }
        let text = String::from_utf16(unsafe { std::slice::from_raw_parts(raw, length) }).map_err(|_| Refusal::Unsupported)?;
        let path = PathBuf::from(text);
        checked_path(&path.join("profile-check"))?;
        Ok(path)
    })();
    unsafe { CoTaskMemFree(raw.cast()); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let path = std::env::temp_dir().join(format!("forge-config-txf-{}-{nonce}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self, name: &str) -> PathBuf { self.0.join(name) }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let actual = std::fs::canonicalize(&self.0).unwrap();
            let temporary = std::fs::canonicalize(std::env::temp_dir()).unwrap();
            assert_eq!(actual.parent(), Some(temporary.as_path()));
            assert!(actual.file_name().unwrap().to_string_lossy().starts_with("forge-config-txf-"));
            std::fs::remove_dir_all(actual).unwrap();
        }
    }
    fn staged(box_: &Scratch) -> PendingPublication {
        let config = box_.path("client.json");
        std::fs::write(&config, b"original private settings").unwrap();
        prepare(review(&config).unwrap(), b"new settings", review(&box_.path("receipt.json")).unwrap(), b"exact request and revision receipt").ok().expect("NTFS transaction source qualification is required")
    }
    #[test]
    fn isolated_changes_and_receipt_publish_together_with_same_file_identity() {
        let box_ = Scratch::new();
        let config = box_.path("client.json");
        let pending = staged(&box_);
        let before = review(&config).unwrap();
        assert_eq!(before.bytes, b"original private settings");
        assert!(!box_.path("receipt.json").exists());
        assert_eq!(pending.commit(), Outcome::Confirmed);
        let after = review(&config).unwrap();
        assert_eq!(after.file, before.file);
        assert_eq!(after.bytes, b"new settings");
        assert!(receipt_matches(&box_.path("receipt.json"), b"exact request and revision receipt"));
    }
    #[test]
    fn independent_write_and_rename_remain_excluded_after_transacted_handles_close() {
        let box_ = Scratch::new();
        let pending = staged(&box_);
        // prepare returned with every transacted file handle closed. Transaction
        // ownership, not an open/close/reopen convention, must still exclude edits.
        assert!(std::fs::write(box_.path("client.json"), b"foreign edit").is_err());
        assert!(std::fs::rename(box_.path("client.json"), box_.path("moved.json")).is_err());
        assert_eq!(pending.commit(), Outcome::Confirmed);
        assert_eq!(std::fs::read(box_.path("client.json")).unwrap(), b"new settings");
    }
    #[test]
    fn changed_revision_is_refused_and_foreign_bytes_survive() {
        let box_ = Scratch::new();
        let path = box_.path("client.json");
        std::fs::write(&path, b"reviewed").unwrap();
        let old = review(&path).unwrap();
        std::fs::write(&path, b"foreign edit").unwrap();
        let result = prepare(old, b"ours", review(&box_.path("receipt.json")).unwrap(), b"receipt");
        assert!(matches!(result, Err(Refusal::Changed)));
        assert_eq!(std::fs::read(&path).unwrap(), b"foreign edit");
        assert!(!box_.path("receipt.json").exists());
    }
    #[test]
    fn same_bytes_in_a_replaced_file_do_not_match_the_reviewed_file_identity() {
        let box_ = Scratch::new();
        let path = box_.path("client.json");
        std::fs::write(&path, b"reviewed").unwrap();
        let old = review(&path).unwrap();
        std::fs::rename(&path, box_.path("original.json")).unwrap();
        std::fs::write(&path, b"reviewed").unwrap();
        assert!(matches!(prepare(old, b"ours", review(&box_.path("receipt.json")).unwrap(), b"receipt"), Err(Refusal::Changed)));
        assert_eq!(std::fs::read(&path).unwrap(), b"reviewed");
    }
    #[test]
    fn replaced_parent_directory_is_refused_without_losing_its_new_contents() {
        let box_ = Scratch::new();
        let parent = box_.path("profile");
        std::fs::create_dir(&parent).unwrap();
        let path = parent.join("client.json");
        std::fs::write(&path, b"reviewed").unwrap();
        let old = review(&path).unwrap();
        std::fs::rename(&parent, box_.path("old-profile")).unwrap();
        std::fs::create_dir(&parent).unwrap();
        std::fs::write(&path, b"foreign edit").unwrap();
        assert!(matches!(prepare(old, b"ours", review(&box_.path("receipt.json")).unwrap(), b"receipt"), Err(Refusal::Changed)));
        assert_eq!(std::fs::read(&path).unwrap(), b"foreign edit");
    }
    #[test]
    fn dropping_prepared_publication_rolls_back_both_files() {
        let box_ = Scratch::new();
        drop(staged(&box_));
        assert_eq!(std::fs::read(box_.path("client.json")).unwrap(), b"original private settings");
        assert!(!box_.path("receipt.json").exists());
    }
    #[test]
    fn absent_target_is_created_without_replacing_a_late_foreign_file() {
        let box_ = Scratch::new();
        let path = box_.path("client.json");
        let old = review(&path).unwrap();
        std::fs::write(&path, b"foreign").unwrap();
        assert!(prepare(old, b"ours", review(&box_.path("receipt.json")).unwrap(), b"receipt").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"foreign");
        let clean = box_.path("new.json");
        let pending = prepare(review(&clean).unwrap(), b"new", review(&box_.path("receipt.json")).unwrap(), b"receipt").ok().unwrap();
        assert!(!clean.exists());
        assert_eq!(pending.commit(), Outcome::Confirmed);
        assert_eq!(std::fs::read(clean).unwrap(), b"new");
    }
    #[test]
    fn a_late_receipt_collision_rolls_back_isolated_config_changes() {
        let box_ = Scratch::new();
        let path = box_.path("client.json");
        std::fs::write(&path, b"reviewed").unwrap();
        let receipt = review(&box_.path("receipt.json")).unwrap();
        std::fs::write(box_.path("receipt.json"), b"foreign receipt").unwrap();
        assert!(matches!(prepare(review(&path).unwrap(), b"ours", receipt, b"receipt"), Err(Refusal::ReceiptExists)));
        assert_eq!(std::fs::read(&path).unwrap(), b"reviewed");
        assert_eq!(std::fs::read(box_.path("receipt.json")).unwrap(), b"foreign receipt");
    }
    #[test]
    fn hard_link_aliases_and_oversized_targets_are_refused_before_publication() {
        let box_ = Scratch::new();
        let path = box_.path("client.json");
        std::fs::write(&path, b"original").unwrap();
        std::fs::hard_link(&path, box_.path("alias.json")).unwrap();
        assert!(matches!(review(&path), Err(Refusal::Unsupported)));
        let large = box_.path("large.json");
        std::fs::write(&large, vec![b'x'; MAX_BYTES + 1]).unwrap();
        assert!(matches!(review(&large), Err(Refusal::TooLarge)));
    }
    #[test]
    fn a_discarded_commit_acknowledgment_recovers_only_the_exact_durable_receipt() {
        let box_ = Scratch::new();
        let pending = staged(&box_);
        let _lost_acknowledgment = pending.commit();
        assert!(receipt_matches(&box_.path("receipt.json"), b"exact request and revision receipt"));
        assert!(!receipt_matches(&box_.path("receipt.json"), b"different request"));
        assert!(!receipt_matches(&box_.path("missing.json"), b"exact request and revision receipt"));
        assert_eq!(std::fs::read(box_.path("client.json")).unwrap(), b"new settings");
    }
    #[test]
    fn native_profile_uses_the_os_and_has_a_local_absolute_parent() {
        let profile = os_user_profile().unwrap();
        assert!(profile.is_dir());
        checked_path(&profile.join("profile-check")).unwrap();
    }
}
