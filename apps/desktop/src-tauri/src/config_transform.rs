//! Pure proposals only. No config, environment, process, network or renderer access.
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use std::collections::HashSet;
use std::fmt;

const LIMIT: usize = 1024 * 1024;
const SERVER: &str = "agent-forge";
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Client {
    Claude,
    Codex,
    Cursor,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    Unreadable,
    Unsupported,
    Foreign,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Proposal {
    AlreadyConfigured,
    Change(Vec<u8>),
}

// serde_json normally retains the last duplicate. Refuse duplicates at every depth
// before using any member or returning a proposal; escaped equivalent keys count.
struct Unique;
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Check;
        impl<'de> Visitor<'de> for Check {
            type Value = Unique;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON without duplicate object keys")
            }
            fn visit_bool<E: de::Error>(self, _: bool) -> Result<Unique, E> {
                Ok(Unique)
            }
            fn visit_i64<E: de::Error>(self, _: i64) -> Result<Unique, E> {
                Ok(Unique)
            }
            fn visit_u64<E: de::Error>(self, _: u64) -> Result<Unique, E> {
                Ok(Unique)
            }
            fn visit_f64<E: de::Error>(self, _: f64) -> Result<Unique, E> {
                Ok(Unique)
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Unique, E> {
                Ok(Unique)
            }
            fn visit_unit<E: de::Error>(self) -> Result<Unique, E> {
                Ok(Unique)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Unique, A::Error> {
                while seq.next_element::<Unique>()?.is_some() {}
                Ok(Unique)
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Unique, A::Error> {
                let mut seen = HashSet::new();
                while let Some(key) = map.next_key::<String>()? {
                    if !seen.insert(key) {
                        return Err(de::Error::custom("duplicate key"));
                    }
                    map.next_value::<Unique>()?;
                }
                Ok(Unique)
            }
        }
        deserializer.deserialize_any(Check)
    }
}
struct Members<'a>(Vec<(String, &'a RawValue)>);
impl<'de> Deserialize<'de> for Members<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Object;
        impl<'de> Visitor<'de> for Object {
            type Value = Members<'de>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                let mut members = Vec::new();
                while let Some(entry) = map.next_entry::<String, &'de RawValue>()? {
                    members.push(entry);
                }
                Ok(Members(members))
            }
        }
        deserializer.deserialize_map(Object)
    }
}
fn members(text: &str) -> Result<Members<'_>, Refusal> {
    serde_json::from_str(text).map_err(|_| Refusal::Unreadable)
}
fn insert_member(whole: &str, object: &str, field: &str) -> Result<String, Refusal> {
    let object_members = members(object)?;
    let offset = (object.as_ptr() as usize)
        .checked_sub(whole.as_ptr() as usize)
        .ok_or(Refusal::Unsupported)?;
    let end = offset
        .checked_add(object.trim_end().len())
        .ok_or(Refusal::Unsupported)?;
    if end > whole.len() || !object.trim_end().ends_with('}') {
        return Err(Refusal::Unsupported);
    }
    let at = end - 1;
    let comma = if object_members.0.is_empty() { "" } else { "," };
    Ok(format!("{}{comma}{field}{}", &whole[..at], &whole[at..]))
}
fn json_proposal(text: &str, command: &str, args: &[String]) -> Result<Proposal, Refusal> {
    serde_json::from_str::<Unique>(text).map_err(|_| Refusal::Unreadable)?;
    let root = members(text)?;
    let entry = serde_json::json!({ "type": "stdio", "command": command, "args": args });
    let field = format!("\"{SERVER}\":{entry}");
    let after = if let Some((_, raw)) = root.0.iter().find(|(key, _)| key == "mcpServers") {
        let servers = members(raw.get()).map_err(|_| Refusal::Unsupported)?;
        if let Some((_, existing)) = servers.0.iter().find(|(key, _)| key == SERVER) {
            let value: serde_json::Value =
                serde_json::from_str(existing.get()).map_err(|_| Refusal::Unreadable)?;
            return if value == entry {
                Ok(Proposal::AlreadyConfigured)
            } else {
                Err(Refusal::Foreign)
            };
        }
        insert_member(text, raw.get(), &field)?
    } else {
        insert_member(text, text, &format!("\"mcpServers\":{{{field}}}"))?
    };
    serde_json::from_str::<Unique>(&after).map_err(|_| Refusal::Unsupported)?;
    let mut expected: serde_json::Value =
        serde_json::from_str(text).map_err(|_| Refusal::Unreadable)?;
    let object = expected.as_object_mut().ok_or(Refusal::Unsupported)?;
    let servers = object
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    servers
        .as_object_mut()
        .ok_or(Refusal::Unsupported)?
        .insert(SERVER.to_owned(), entry);
    let parsed: serde_json::Value =
        serde_json::from_str(&after).map_err(|_| Refusal::Unsupported)?;
    if parsed != expected {
        return Err(Refusal::Unsupported);
    }
    Ok(Proposal::Change(after.into_bytes()))
}
fn toml_proposal(text: &str, command: &str, args: &[String]) -> Result<Proposal, Refusal> {
    let mut expected: toml::Table = text.parse().map_err(|_| Refusal::Unreadable)?;
    let entry: toml::Table = [
        (
            "command".to_owned(),
            toml::Value::String(command.to_owned()),
        ),
        (
            "args".to_owned(),
            toml::Value::Array(args.iter().cloned().map(toml::Value::String).collect()),
        ),
    ]
    .into_iter()
    .collect();
    let servers = expected
        .entry("mcp_servers")
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    let servers = servers.as_table_mut().ok_or(Refusal::Unsupported)?;
    if let Some(existing) = servers.get(SERVER) {
        return if existing == &toml::Value::Table(entry) {
            Ok(Proposal::AlreadyConfigured)
        } else {
            Err(Refusal::Foreign)
        };
    }
    let suffix = format!(
        "\n[mcp_servers.{SERVER}]\n{}",
        toml::to_string(&entry).map_err(|_| Refusal::Unsupported)?
    );
    servers.insert(SERVER.to_owned(), toml::Value::Table(entry));
    let after = format!("{text}{suffix}");
    // An inline/sealed table cannot be extended. Parsing the complete proposal
    // refuses it instead of rewriting unrelated configuration into another form.
    let parsed: toml::Table = after.parse().map_err(|_| Refusal::Unsupported)?;
    if parsed != expected {
        return Err(Refusal::Unsupported);
    }
    Ok(Proposal::Change(after.into_bytes()))
}
pub fn propose(
    client: Client,
    bytes: &[u8],
    exists: bool,
    command: &str,
    args: &[String],
) -> Result<Proposal, Refusal> {
    if bytes.len() > LIMIT
        || command.is_empty()
        || args.len() != 5
        || args[0] != "--mcp-stdio"
        || args[1] != "--root"
        || args[3] != "--home"
    {
        return Err(Refusal::Unsupported);
    }
    // Both JSON clients interpret dollar substitutions. Refuse ambiguous literal
    // selectors rather than accidentally creating a different launch command.
    if std::iter::once(command)
        .chain(args.iter().map(String::as_str))
        .any(|s| s.len() > 4096 || s.contains('$') || s.chars().any(char::is_control))
    {
        return Err(Refusal::Unsupported);
    }
    if !exists && !bytes.is_empty() {
        return Err(Refusal::Unsupported);
    }
    let text = std::str::from_utf8(bytes).map_err(|_| Refusal::Unreadable)?;
    let proposal = if client == Client::Codex {
        toml_proposal(text, command, args)
    } else {
        json_proposal(if !exists { "{}\n" } else { text }, command, args)
    }?;
    if matches!(&proposal, Proposal::Change(after) if after.len() > LIMIT) {
        return Err(Refusal::Unsupported);
    }
    Ok(proposal)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn args() -> Vec<String> {
        [
            "--mcp-stdio",
            "--root",
            "C:\\Forge Workspace",
            "--home",
            "C:\\Private Home",
        ]
        .map(str::to_owned)
        .to_vec()
    }
    fn change(client: Client, before: &[u8], exists: bool) -> Vec<u8> {
        match propose(client, before, exists, "C:\\App\\hearth.exe", &args()).unwrap() {
            Proposal::Change(bytes) => bytes,
            _ => panic!("expected a new proposal"),
        }
    }
    #[test]
    fn missing_json_configs_are_proposed_without_any_environment_or_operator_grant() {
        for client in [Client::Claude, Client::Cursor] {
            let after = change(client, b"", false);
            let parsed: serde_json::Value = serde_json::from_slice(&after).unwrap();
            assert_eq!(
                parsed,
                serde_json::json!({"mcpServers":{"agent-forge":{"type":"stdio","command":"C:\\App\\hearth.exe","args":args()}}})
            );
            assert_eq!(
                propose(client, &after, true, "C:\\App\\hearth.exe", &args()),
                Ok(Proposal::AlreadyConfigured)
            );
        }
    }
    #[test]
    fn json_insertion_preserves_every_unrelated_byte_and_foreign_server() {
        let prefix = "{\r\n  \"secret\" : \"PRIVATE_CONFIG\\n\", \"large\": 9007199254740993,\n\"mcpServers\" : { \"other\" : {\"env\":{\"TOKEN\":\"private\"}} ";
        let suffix = "}\n,\"array\":[null,true,1e-5,\"}\\\"\"] }\r\n";
        let before = format!("{prefix}{suffix}");
        let after = String::from_utf8(change(Client::Claude, before.as_bytes(), true)).unwrap();
        assert!(after.starts_with(prefix));
        assert!(after.ends_with(suffix));
        assert_eq!(after.matches("PRIVATE_CONFIG").count(), 1);
        assert_eq!(after.matches("9007199254740993").count(), 1);
    }
    #[test]
    fn absent_servers_object_is_inserted_without_reserializing_the_root() {
        let before = b" { \"private\" : [1,2,3] } \n";
        let after = String::from_utf8(change(Client::Cursor, before, true)).unwrap();
        assert!(after.starts_with(" { \"private\" : [1,2,3] "));
        assert!(after.ends_with("} \n"));
    }
    #[test]
    fn foreign_owned_key_is_never_overwritten_even_with_matching_command() {
        for extra in [
            serde_json::json!({"env":{"TOKEN":"private"}}),
            serde_json::json!({"disabled":true}),
        ] {
            let mut entry =
                serde_json::json!({"type":"stdio","command":"C:\\App\\hearth.exe","args":args()});
            entry
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let before = serde_json::json!({"mcpServers":{"agent-forge":entry}}).to_string();
            assert_eq!(
                propose(
                    Client::Claude,
                    before.as_bytes(),
                    true,
                    "C:\\App\\hearth.exe",
                    &args()
                ),
                Err(Refusal::Foreign)
            );
        }
    }
    #[test]
    fn duplicate_keys_including_escaped_and_nested_keys_are_refused() {
        for text in [
            r#"{"mcpServers":{},"mcpServers":{}}"#,
            r#"{"a":1,"\u0061":2}"#,
            r#"{"other":[{"secret":1,"secret":2}]}"#,
        ] {
            assert_eq!(
                propose(
                    Client::Cursor,
                    text.as_bytes(),
                    true,
                    "C:\\App\\hearth.exe",
                    &args()
                ),
                Err(Refusal::Unreadable)
            );
        }
    }
    #[test]
    fn malformed_nonobject_oversized_and_interpolated_input_has_no_proposal() {
        for text in ["", "[]", "null", "{", "{\"mcpServers\":null}", "\u{feff}{}"] {
            assert!(propose(
                Client::Claude,
                text.as_bytes(),
                true,
                "C:\\App\\hearth.exe",
                &args()
            )
            .is_err());
        }
        assert!(propose(
            Client::Claude,
            &vec![b' '; LIMIT + 1],
            true,
            "C:\\App\\hearth.exe",
            &args()
        )
        .is_err());
        assert!(propose(Client::Claude, b"{}", true, "$HOME\\hearth.exe", &args()).is_err());
        let mut bad = args();
        bad.push("--operator".to_owned());
        assert!(propose(Client::Claude, b"{}", true, "C:\\App\\hearth.exe", &bad).is_err());
    }
    #[test]
    fn toml_preserves_comments_multiline_values_and_other_servers_byte_for_byte() {
        let before = "# private header\r\nmodel = 'example'\r\nnotes = '''\n[mcp_servers.fake]\n'''\n[mcp_servers.other]\ncommand='foreign' # retain\nargs=['x']\n";
        let after = String::from_utf8(change(Client::Codex, before.as_bytes(), true)).unwrap();
        assert!(after.starts_with(before));
        assert_eq!(
            propose(
                Client::Codex,
                after.as_bytes(),
                true,
                "C:\\App\\hearth.exe",
                &args()
            ),
            Ok(Proposal::AlreadyConfigured)
        );
        let table: toml::Table = after.parse().unwrap();
        assert_eq!(
            table["mcp_servers"]["agent-forge"]["command"].as_str(),
            Some("C:\\App\\hearth.exe")
        );
    }
    #[test]
    fn missing_toml_proposal_has_exact_fixed_arguments_and_no_extra_grant() {
        let after = change(Client::Codex, b"", false);
        let table: toml::Table = std::str::from_utf8(&after).unwrap().parse().unwrap();
        assert_eq!(table.len(), 1);
        let entry = table["mcp_servers"]["agent-forge"].as_table().unwrap();
        assert_eq!(entry.len(), 2);
        assert_eq!(entry["args"].as_array().unwrap().len(), 5);
    }
    #[test]
    fn toml_foreign_entry_inline_tables_and_invalid_documents_are_refused() {
        for text in [
            "[mcp_servers.agent-forge]\ncommand='other'\n",
            "[mcp_servers.'agent-forge']\ncommand='other'\n",
        ] {
            assert_eq!(
                propose(
                    Client::Codex,
                    text.as_bytes(),
                    true,
                    "C:\\App\\hearth.exe",
                    &args()
                ),
                Err(Refusal::Foreign)
            );
        }
        for text in [
            "mcp_servers = { other = { command = 'foreign' } }\n",
            "mcp_servers = []\n",
            "model='a'\nmodel='b'\n",
        ] {
            assert!(propose(
                Client::Codex,
                text.as_bytes(),
                true,
                "C:\\App\\hearth.exe",
                &args()
            )
            .is_err());
        }
    }
}
