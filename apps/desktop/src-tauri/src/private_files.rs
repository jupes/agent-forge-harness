//! Owner-private native journals. No ACL takeover and no path-based deletion.
#![allow(dead_code)]
use crate::config_publish;
use std::ffi::c_void;
use std::fs::File;
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::Path;
use std::ptr::{null, null_mut};
type Handle = *mut c_void;
#[repr(C)]
struct Attributes {
    length: u32,
    descriptor: *mut c_void,
    inherit: i32,
}
#[repr(C)]
#[derive(Default)]
struct AclSize {
    count: u32,
    used: u32,
    free: u32,
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> Handle;
    fn CloseHandle(handle: Handle) -> i32;
    fn LocalFree(memory: Handle) -> Handle;
    fn GetLastError() -> u32;
    fn CreateDirectoryW(path: *const u16, security: *const Attributes) -> i32;
    fn CreateFileW(path: *const u16, access: u32, share: u32, security: *const Attributes, disposition: u32, flags: u32, template: Handle) -> Handle;
    fn SetFileInformationByHandle(file: Handle, class: u32, data: *const c_void, size: u32) -> i32;
}
#[link(name = "advapi32")]
unsafe extern "system" {
    fn OpenProcessToken(process: Handle, access: u32, token: *mut Handle) -> i32;
    fn GetTokenInformation(token: Handle, class: u32, data: *mut c_void, size: u32, needed: *mut u32) -> i32;
    fn ConvertSidToStringSidW(sid: *const c_void, text: *mut *mut u16) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(text: *const u16, revision: u32, descriptor: *mut Handle, size: *mut u32) -> i32;
    fn GetSecurityInfo(object: Handle, kind: u32, info: u32, owner: *mut Handle, group: *mut Handle, dacl: *mut Handle, sacl: *mut Handle, descriptor: *mut Handle) -> u32;
    fn GetSecurityDescriptorControl(descriptor: Handle, control: *mut u16, revision: *mut u32) -> i32;
    fn GetAclInformation(acl: Handle, data: *mut c_void, size: u32, class: u32) -> i32;
    fn GetAce(acl: Handle, index: u32, ace: *mut Handle) -> i32;
    fn EqualSid(a: *const c_void, b: *const c_void) -> i32;
    fn GetLengthSid(sid: *const c_void) -> u32;
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Unavailable;
struct Local(Handle);
impl Drop for Local {
    fn drop(&mut self) { unsafe { LocalFree(self.0); } }
}
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
fn current_sid() -> Result<(Vec<u8>, String), Unavailable> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut token) } == 0 { return Err(Unavailable); }
    let result = (|| {
        let mut size = 0;
        unsafe { GetTokenInformation(token, 1, null_mut(), 0, &mut size); }
        if !(16..=65536).contains(&size) { return Err(Unavailable); }
        let mut data = vec![0u8; size as usize];
        if unsafe { GetTokenInformation(token, 1, data.as_mut_ptr().cast(), size, &mut size) } == 0 { return Err(Unavailable); }
        let sid = unsafe { std::ptr::read_unaligned(data.as_ptr().cast::<Handle>()) };
        let length = unsafe { GetLengthSid(sid) } as usize;
        let start = sid as usize;
        let base = data.as_ptr() as usize;
        if !(8..=68).contains(&length) || start < base || start.checked_add(length).is_none_or(|end| end > base + data.len()) { return Err(Unavailable); }
        let bytes = unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), length) }.to_vec();
        let mut raw = null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut raw) } == 0 || raw.is_null() { return Err(Unavailable); }
        let _allocation = Local(raw.cast());
        let mut len = 0;
        while len <= 256 && unsafe { *raw.add(len) } != 0 { len += 1; }
        if len > 256 { return Err(Unavailable); }
        let text = String::from_utf16(unsafe { std::slice::from_raw_parts(raw, len) }).map_err(|_| Unavailable)?;
        if !text.starts_with("S-1-") || text.chars().any(|c| !c.is_ascii_digit() && c != 'S' && c != '-') { return Err(Unavailable); }
        Ok((bytes, text))
    })();
    unsafe { CloseHandle(token); }
    result
}
struct Security {
    descriptor: Local,
    sid: Vec<u8>,
}
impl Security {
    fn new(directory: bool) -> Result<Self, Unavailable> {
        let (sid, text) = current_sid()?;
        let flags = if directory { "OICI" } else { "" };
        let sddl: Vec<u16> = format!("O:{text}D:P(A;{flags};FA;;;{text})(A;{flags};FA;;;SY)").encode_utf16().chain(Some(0)).collect();
        let mut descriptor = null_mut();
        if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, null_mut()) } == 0 || descriptor.is_null() { return Err(Unavailable); }
        Ok(Self { descriptor: Local(descriptor), sid })
    }
    fn attributes(&self) -> Attributes {
        Attributes { length: std::mem::size_of::<Attributes>() as u32, descriptor: self.descriptor.0, inherit: 0 }
    }
    fn verify(&self, file: &File, directory: bool, inherited_receipt: bool) -> Result<(), Unavailable> {
        config_publish::validate_handle(file, directory).map_err(|_| Unavailable)?;
        let mut owner = null_mut();
        let mut dacl = null_mut();
        let mut descriptor = null_mut();
        if unsafe { GetSecurityInfo(file.as_raw_handle(), 1, 5, &mut owner, null_mut(), &mut dacl, null_mut(), &mut descriptor) } != 0 || descriptor.is_null() { return Err(Unavailable); }
        let _allocation = Local(descriptor);
        if owner.is_null() || dacl.is_null() || unsafe { EqualSid(owner, self.sid.as_ptr().cast()) } == 0 { return Err(Unavailable); }
        let mut control = 0;
        let mut revision = 0;
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) } == 0 || (!inherited_receipt && control & 0x1000 == 0) { return Err(Unavailable); }
        let mut size = AclSize::default();
        if unsafe { GetAclInformation(dacl, (&mut size as *mut AclSize).cast(), std::mem::size_of::<AclSize>() as u32, 2) } == 0 || size.count == 0 || size.count > 8 { return Err(Unavailable); }
        let system: [u8; 12] = [1,1,0,0,0,0,0,5,18,0,0,0];
        let mut user_full = false;
        for index in 0..size.count {
            let mut ace = null_mut();
            if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() { return Err(Unavailable); }
            let start = ace.cast::<u8>();
            let kind = unsafe { *start };
            let flags = unsafe { *start.add(1) };
            let length = unsafe { std::ptr::read_unaligned(start.add(2).cast::<u16>()) } as usize;
            if kind != 0 || length < 20 || (directory && flags != 3) || (!directory && flags != 0 && !(inherited_receipt && flags == 16)) { return Err(Unavailable); }
            let mask = unsafe { std::ptr::read_unaligned(start.add(4).cast::<u32>()) };
            let trustee = unsafe { start.add(8) }.cast::<c_void>();
            let sid_length = unsafe { GetLengthSid(trustee) } as usize;
            if sid_length + 8 != length || !(8..=68).contains(&sid_length) { return Err(Unavailable); }
            let user = unsafe { EqualSid(trustee, self.sid.as_ptr().cast()) } != 0;
            if !user && unsafe { EqualSid(trustee, system.as_ptr().cast()) } == 0 { return Err(Unavailable); }
            if user && mask & 0x001f01ff == 0x001f01ff { user_full = true; }
        }
        if !user_full { return Err(Unavailable); }
        Ok(())
    }
}
fn file(handle: Handle) -> Result<File, Unavailable> {
    if handle.is_null() || handle == -1isize as Handle { return Err(Unavailable); }
    Ok(unsafe { File::from_raw_handle(handle) })
}
pub struct Directory {
    _pins: Vec<File>,
    _file: File,
}
/// Existing directories are validated without changing their security descriptor.
pub fn directory(path: &Path, create: bool) -> Result<Directory, Unavailable> {
    let pins = config_publish::pin_path(path).map_err(|_| Unavailable)?;
    let security = Security::new(true)?;
    if create && unsafe { CreateDirectoryW(wide(path).as_ptr(), &security.attributes()) } == 0 && unsafe { GetLastError() } != 183 { return Err(Unavailable); }
    let opened = file(unsafe { CreateFileW(wide(path).as_ptr(), 0x20080, 3, null(), 3, 0x02200000, null_mut()) })?;
    security.verify(&opened, true, false)?;
    Ok(Directory { _pins: pins, _file: opened })
}
/// First visibility is private. Failure leaves a private incomplete record and
/// refuses the effect; no old journal is truncated, replaced or silently repaired.
pub fn create(path: &Path, bytes: &[u8]) -> Result<(), Unavailable> {
    if bytes.len() > 6 * 1024 * 1024 { return Err(Unavailable); }
    let _pins = config_publish::pin_path(path).map_err(|_| Unavailable)?;
    let security = Security::new(false)?;
    let mut opened = file(unsafe { CreateFileW(wide(path).as_ptr(), 0xc0000000, 1, &security.attributes(), 1, 0x80200000, null_mut()) })?;
    security.verify(&opened, false, false)?;
    opened.write_all(bytes).map_err(|_| Unavailable)?;
    opened.sync_all().map_err(|_| Unavailable)
}
fn read_with(path: &Path, max: usize, inherited_receipt: bool, deletion: bool) -> Result<(File, Vec<File>, Vec<u8>), Unavailable> {
    if max > 6 * 1024 * 1024 { return Err(Unavailable); }
    let pins = config_publish::pin_path(path).map_err(|_| Unavailable)?;
    let security = Security::new(false)?;
    let opened = file(unsafe { CreateFileW(wide(path).as_ptr(), 0x80000000 | if deletion { 0x10000 } else { 0 }, 1, null(), 3, 0x00200000, null_mut()) })?;
    security.verify(&opened, false, inherited_receipt)?;
    let mut bytes = Vec::new();
    (&opened).take((max + 1) as u64).read_to_end(&mut bytes).map_err(|_| Unavailable)?;
    if bytes.len() > max { return Err(Unavailable); }
    Ok((opened, pins, bytes))
}
pub fn read(path: &Path, max: usize) -> Result<Vec<u8>, Unavailable> {
    read_with(path, max, false, false).map(|(_, _, bytes)| bytes)
}
/// Caller holds the protected private parent directory; inherited user/SYSTEM
/// receipt ACEs are accepted only after same-handle owner and trustee validation.
pub fn receipt(path: &Path, expected: &[u8]) -> bool {
    !expected.is_empty() && expected.len() <= 8192 && read_with(path, 8192, true, false).is_ok_and(|(_, _, bytes)| bytes == expected)
}
pub fn remove_exact(path: &Path, expected: &[u8]) -> Result<(), Unavailable> {
    let (opened, _pins, bytes) = read_with(path, 8192, false, true)?;
    if bytes != expected { return Err(Unavailable); }
    let remove = 1u8;
    if unsafe { SetFileInformationByHandle(opened.as_raw_handle(), 4, (&remove as *const u8).cast(), 1) } == 0 { return Err(Unavailable); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new() -> Self {
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            Self(std::env::temp_dir().join(format!("forge-private-journal-{}-{nonce}", std::process::id())))
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            if !self.0.exists() { return; }
            let actual = std::fs::canonicalize(&self.0).unwrap();
            let temporary = std::fs::canonicalize(std::env::temp_dir()).unwrap();
            assert_eq!(actual.parent(), Some(temporary.as_path()));
            assert!(actual.file_name().unwrap().to_string_lossy().starts_with("forge-private-journal-"));
            std::fs::remove_dir_all(actual).unwrap();
        }
    }
    #[test]
    fn journal_is_private_on_creation_durable_and_create_only() {
        let box_ = Scratch::new();
        let _directory = directory(&box_.0, true).unwrap();
        let path = box_.0.join("original.json");
        create(&path, b"private original").unwrap();
        assert_eq!(read(&path, 1024).unwrap(), b"private original");
        assert!(create(&path, b"replacement").is_err());
        assert_eq!(read(&path, 1024).unwrap(), b"private original");
        assert!(read(&path, 2).is_err());
    }
    #[test]
    fn an_existing_public_directory_is_refused_without_acl_takeover() {
        let box_ = Scratch::new();
        std::fs::create_dir(&box_.0).unwrap();
        assert!(directory(&box_.0, false).is_err());
        assert!(directory(&box_.0, true).is_err());
        assert!(box_.0.is_dir());
    }
    #[test]
    fn hard_link_journals_and_foreign_deletion_bytes_are_refused() {
        let box_ = Scratch::new();
        let guard = directory(&box_.0, true).unwrap();
        let path = box_.0.join("pending.json");
        create(&path, b"exact metadata").unwrap();
        assert!(remove_exact(&path, b"foreign metadata").is_err());
        assert_eq!(read(&path, 1024).unwrap(), b"exact metadata");
        std::fs::hard_link(&path, box_.0.join("alias.json")).unwrap();
        assert!(read(&path, 1024).is_err());
        drop(guard);
    }
    #[test]
    fn exact_cleanup_deletes_only_the_verified_open_record() {
        let box_ = Scratch::new();
        let _guard = directory(&box_.0, true).unwrap();
        let path = box_.0.join("pending.json");
        create(&path, b"exact metadata").unwrap();
        remove_exact(&path, b"exact metadata").unwrap();
        assert!(!path.exists());
    }
}
