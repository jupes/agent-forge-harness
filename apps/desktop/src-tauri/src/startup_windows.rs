use crate::startup::{self, Entry, HelperCommand, Outcome, Registration, Registry};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS},
        System::{Com::CoTaskMemFree, Registry::*},
        UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath, KF_FLAG_DEFAULT},
    },
};

const RUN: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const VALUE: PCWSTR = w!("dev.agentforge.harness");
struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}
struct UserRegistry;
impl Registry for UserRegistry {
    fn read(&mut self) -> Result<Entry, ()> {
        let mut key = HKEY::default();
        let status =
            unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, RUN, None, KEY_QUERY_VALUE, &mut key) };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(Entry::Absent);
        }
        if status != ERROR_SUCCESS {
            return Err(());
        }
        let key = Key(key);
        let mut bytes = [0u8; 524];
        let mut size = bytes.len() as u32;
        let mut kind = REG_VALUE_TYPE::default();
        let status = unsafe {
            RegQueryValueExW(
                key.0,
                VALUE,
                None,
                Some(&mut kind),
                Some(bytes.as_mut_ptr()),
                Some(&mut size),
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(Entry::Absent);
        }
        if status == ERROR_MORE_DATA {
            return Ok(Entry::Invalid);
        }
        if status != ERROR_SUCCESS {
            return Err(());
        }
        if kind != REG_SZ || size < 2 || size as usize > bytes.len() || size % 2 != 0 {
            return Ok(Entry::Invalid);
        }
        let units: Vec<_> = bytes[..size as usize]
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        if units.last() != Some(&0) || units[..units.len() - 1].contains(&0) {
            return Ok(Entry::Invalid);
        }
        Ok(String::from_utf16(&units[..units.len() - 1]).map_or(Entry::Invalid, Entry::Text))
    }
    fn write(&mut self, value: Option<&str>) -> Result<(), ()> {
        let mut key = HKEY::default();
        // The only writable address is this user's one fixed Run value.
        let status = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                RUN,
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_QUERY_VALUE | KEY_SET_VALUE,
                None,
                &mut key,
                None,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(());
        }
        let key = Key(key);
        let status = if let Some(text) = value {
            let bytes: Vec<_> = text
                .encode_utf16()
                .chain(Some(0))
                .flat_map(u16::to_le_bytes)
                .collect();
            unsafe { RegSetValueExW(key.0, VALUE, None, REG_SZ, Some(&bytes)) }
        } else {
            unsafe { RegDeleteValueW(key.0, VALUE) }
        };
        if status == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(())
        }
    }
}
fn registration(value: Registration) -> &'static str {
    match value {
        Registration::Disabled => "disabled",
        Registration::Enabled => "enabled",
        Registration::Conflict => "conflict",
    }
}
pub fn run(command: HelperCommand) -> Result<serde_json::Value, ()> {
    let exe = std::env::current_exe().map_err(|_| ())?;
    let expected = startup::command(exe.to_str().ok_or(())?)?;
    // Resolve the actual OS user, independently of AGENT_FORGE_HOME and process-home overrides.
    let allocated = unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, KF_FLAG_DEFAULT, None) }
        .map_err(|_| ())?;
    let directory = unsafe { allocated.to_string() }.map_err(|_| ());
    unsafe {
        CoTaskMemFree(Some(allocated.0.cast()));
    }
    let directory = directory?;
    let mut registry = UserRegistry;
    let (outcome, observed) = match command {
        HelperCommand::Read => ("read", Some(startup::inspect(&mut registry, &expected)?)),
        HelperCommand::Set {
            enabled,
            expected: prior,
        } => match startup::set(&mut registry, &expected, prior, enabled) {
            Outcome::Completed(value) => ("completed", Some(value)),
            Outcome::Refused(value) => ("refused", Some(value)),
            Outcome::Unconfirmed => ("unconfirmed", None),
        },
    };
    Ok(
        serde_json::json!({ "version":1, "expectedCommand":expected, "coordinationParent":directory, "outcome":outcome, "registration":observed.map(registration) }),
    )
}
