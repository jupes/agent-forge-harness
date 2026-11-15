//! Private parent-native IPC data, never a renderer response or command selector.
use serde::Deserialize;
use std::path::Path;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegistrationContext {
    version: u8,
    pub root: String,
    pub home: String,
    pub command: String,
    pub args: Vec<String>,
}
fn same_native_path(value: &str, expected: &Path) -> bool {
    #[cfg(windows)]
    {
        let strip = |text: &str| text.strip_prefix(r"\\?\").unwrap_or(text).to_owned();
        expected
            .to_str()
            .is_some_and(|text| strip(value) == strip(text))
    }
    #[cfg(not(windows))]
    {
        Path::new(value) == expected
    }
}
impl RegistrationContext {
    pub fn from_ready(raw: serde_json::Value, root: &Path, command: &Path) -> Option<Self> {
        if serde_json::to_vec(&raw).ok()?.len() > 2048 {
            return None;
        }
        let value: Self = serde_json::from_value(raw).ok()?;
        let selector = |s: &str| {
            !s.is_empty()
                && s.encode_utf16().count() <= 1024
                && !s.chars().any(char::is_control)
                && Path::new(s).is_absolute()
        };
        let expected = [
            "--mcp-stdio",
            "--root",
            value.root.as_str(),
            "--home",
            value.home.as_str(),
        ];
        if value.version != 1
            || !selector(&value.root)
            || !selector(&value.home)
            || !selector(&value.command)
            || !same_native_path(&value.root, root)
            || !same_native_path(&value.command, command)
            || value.args != expected
        {
            return None;
        }
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    fn fixture() -> (serde_json::Value, PathBuf, PathBuf) {
        let root = PathBuf::from(if cfg!(windows) { "C:\\forge" } else { "/forge" });
        let command = root.join("hearth.exe");
        let home = root.join("private-home");
        let value = json!({
            "version": 1,
            "root": root,
            "home": home,
            "command": command,
            "args": ["--mcp-stdio", "--root", root, "--home", home]
        });
        (value, root, command)
    }
    #[cfg(windows)]
    #[test]
    fn exact_extended_disk_spelling_is_equivalent_but_other_paths_are_not() {
        let (raw, root, command) = fixture();
        let extended_root = PathBuf::from(format!(r"\\?\{}", root.display()));
        let extended_command = PathBuf::from(format!(r"\\?\{}", command.display()));
        assert!(
            RegistrationContext::from_ready(raw.clone(), &extended_root, &extended_command)
                .is_some()
        );
        assert!(RegistrationContext::from_ready(
            raw.clone(),
            &extended_root.join("other"),
            &extended_command
        )
        .is_none());
        assert!(RegistrationContext::from_ready(
            raw,
            &extended_root,
            &extended_command.with_file_name("other.exe")
        )
        .is_none());
    }
    #[test]
    fn exact_private_context_binds_native_root_asset_and_home() {
        let parse = RegistrationContext::from_ready;
        let (raw, root, command) = fixture();
        let value = parse(raw, &root, &command).unwrap();
        assert_eq!(Path::new(&value.root), root);
        assert_eq!(Path::new(&value.command), command);
        assert_eq!(value.args[4], value.home);
    }
    #[test]
    fn foreign_assets_and_roots_never_supply_registration_authority() {
        let parse = RegistrationContext::from_ready;
        let (raw, root, command) = fixture();
        assert!(parse(raw.clone(), &root.join("other"), &command).is_none());
        assert!(parse(raw, &root, &root.join("foreign.exe")).is_none());
    }
    #[test]
    fn malformed_operator_and_unknown_fields_are_ignored_as_unavailable() {
        let parse = RegistrationContext::from_ready;
        for key in ["version", "home", "args", "operator"] {
            let (mut raw, root, command) = fixture();
            raw[key] = json!("--operator");
            assert!(parse(raw, &root, &command).is_none());
        }
        let (mut raw, root, command) = fixture();
        raw["args"]
            .as_array_mut()
            .unwrap()
            .push(json!("--operator"));
        assert!(parse(raw, &root, &command).is_none());
    }
    #[test]
    fn relative_control_and_oversized_contexts_remain_unavailable() {
        let parse = RegistrationContext::from_ready;
        for home in [
            "relative".to_string(),
            "bad\nselector".to_string(),
            "x".repeat(2049),
        ] {
            let (mut raw, root, command) = fixture();
            raw["home"] = json!(home);
            assert!(parse(raw, &root, &command).is_none());
        }
    }
}
