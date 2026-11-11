/// Pure policy for one app-owned, current-user Windows startup entry.
pub const LOGIN_FLAG: &str = "--from-login";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Registration {
    Disabled,
    Enabled,
    Conflict,
}
pub enum Entry {
    Absent,
    Text(String),
    Invalid,
}
pub trait Registry {
    fn read(&mut self) -> Result<Entry, ()>;
    fn write(&mut self, value: Option<&str>) -> Result<(), ()>;
}
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Completed(Registration),
    Refused(Registration),
    Unconfirmed,
}
#[derive(Debug, PartialEq, Eq)]
pub enum HelperCommand {
    Read,
    Set {
        enabled: bool,
        expected: Registration,
    },
}
pub fn parse_arguments(args: &[&str]) -> Result<HelperCommand, ()> {
    match args {
        ["--startup-registration", "read"] => Ok(HelperCommand::Read),
        ["--startup-registration", "set", desired, expected] => {
            let enabled = match *desired {
                "enabled" => true,
                "disabled" => false,
                _ => return Err(()),
            };
            let expected = match *expected {
                "enabled" => Registration::Enabled,
                "disabled" => Registration::Disabled,
                _ => return Err(()),
            };
            Ok(HelperCommand::Set { enabled, expected })
        }
        _ => Err(()),
    }
}

pub fn command(exe: &str) -> Result<String, ()> {
    let bytes = exe.as_bytes();
    if bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || &bytes[1..3] != b":\\"
        || exe.contains(['\0', '"', '\r', '\n'])
    {
        return Err(());
    }
    let command = format!("\"{exe}\" {LOGIN_FLAG}");
    if command.encode_utf16().count() > 260 {
        return Err(());
    }
    Ok(command)
}
pub fn inspect(registry: &mut impl Registry, expected: &str) -> Result<Registration, ()> {
    Ok(match registry.read()? {
        Entry::Absent => Registration::Disabled,
        Entry::Text(value) if value == expected => Registration::Enabled,
        _ => Registration::Conflict,
    })
}
pub fn set(
    registry: &mut impl Registry,
    command: &str,
    expected: Registration,
    enabled: bool,
) -> Outcome {
    let Ok(current) = inspect(registry, command) else {
        return Outcome::Unconfirmed;
    };
    if current == Registration::Conflict || current != expected {
        return Outcome::Refused(current);
    }
    let desired = if enabled {
        Registration::Enabled
    } else {
        Registration::Disabled
    };
    if current != desired && registry.write(enabled.then_some(command)).is_err() {
        return Outcome::Unconfirmed;
    }
    match inspect(registry, command) {
        Ok(observed) if observed == desired => Outcome::Completed(observed),
        _ => Outcome::Unconfirmed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake {
        entry: Entry,
        writes: usize,
    }
    impl Registry for Fake {
        fn read(&mut self) -> Result<Entry, ()> {
            Ok(match &self.entry {
                Entry::Absent => Entry::Absent,
                Entry::Text(s) => Entry::Text(s.clone()),
                Entry::Invalid => Entry::Invalid,
            })
        }
        fn write(&mut self, value: Option<&str>) -> Result<(), ()> {
            self.writes += 1;
            self.entry = value.map_or(Entry::Absent, |s| Entry::Text(s.to_owned()));
            Ok(())
        }
    }
    #[test]
    fn enable_and_disable_only_the_reviewed_exact_owned_registration() {
        let command = command(r"C:\Program Files\Agent Forge\Agent Forge Harness.exe").unwrap();
        assert_eq!(
            command,
            "\"C:\\Program Files\\Agent Forge\\Agent Forge Harness.exe\" --from-login"
        );
        let mut registry = Fake {
            entry: Entry::Absent,
            writes: 0,
        };
        assert_eq!(
            set(&mut registry, &command, Registration::Disabled, true),
            Outcome::Completed(Registration::Enabled)
        );
        assert_eq!(registry.writes, 1);
        assert_eq!(
            set(&mut registry, &command, Registration::Enabled, false),
            Outcome::Completed(Registration::Disabled)
        );
        assert_eq!(registry.writes, 2);
    }
    #[test]
    fn invalid_target_and_helper_arguments_are_inert() {
        for exe in [
            "relative.exe",
            r"\\server\share\app.exe",
            "C:\\bad\"app.exe",
            "C:\\bad\0app.exe",
        ] {
            assert!(command(exe).is_err());
        }
        let prefix = r"C:\";
        let good = format!("{prefix}{}", "a".repeat(242));
        assert_eq!(command(&good).unwrap().encode_utf16().count(), 260);
        assert!(command(&(good + "a")).is_err());
        for args in [
            vec!["--startup-registration"],
            vec!["--startup-registration", "read", "extra"],
            vec!["--startup-registration", "set", "yes", "disabled"],
            vec!["--startup-registration", "set", "enabled", "conflict"],
        ] {
            assert!(parse_arguments(&args).is_err());
        }
        assert_eq!(
            parse_arguments(&["--startup-registration", "read"]),
            Ok(HelperCommand::Read)
        );
    }
    #[test]
    fn foreign_malformed_and_stale_registration_is_never_modified() {
        for entry in [Entry::Text("other app".to_owned()), Entry::Invalid] {
            let mut registry = Fake { entry, writes: 0 };
            assert_eq!(
                set(&mut registry, "our app", Registration::Disabled, true),
                Outcome::Refused(Registration::Conflict)
            );
            assert_eq!(registry.writes, 0);
        }
        let mut registry = Fake {
            entry: Entry::Text("our app".into()),
            writes: 0,
        };
        assert_eq!(
            set(&mut registry, "our app", Registration::Disabled, false),
            Outcome::Refused(Registration::Enabled)
        );
        assert_eq!(registry.writes, 0);
    }
    #[test]
    fn mutation_or_readback_failure_is_unconfirmed_and_never_retried() {
        struct Failing {
            writes: usize,
            fail_readback: bool,
        }
        impl Registry for Failing {
            fn read(&mut self) -> Result<Entry, ()> {
                if self.writes == 0 {
                    Ok(Entry::Absent)
                } else {
                    Err(())
                }
            }
            fn write(&mut self, _: Option<&str>) -> Result<(), ()> {
                self.writes += 1;
                if self.fail_readback {
                    Ok(())
                } else {
                    Err(())
                }
            }
        }
        for fail_readback in [true, false] {
            let mut registry = Failing {
                writes: 0,
                fail_readback,
            };
            assert_eq!(
                set(&mut registry, "our app", Registration::Disabled, true),
                Outcome::Unconfirmed
            );
            assert_eq!(registry.writes, 1);
        }
    }
}
