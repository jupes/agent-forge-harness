use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
};

fn validate(root: &Path) -> Result<PathBuf, &'static str> {
    let root = fs::canonicalize(root).map_err(|_| "invalid checkout root")?;
    if !root.is_dir()
        || !root.join("scripts/hearth/server.ts").is_file()
        || !root.join(".git").exists()
    {
        return Err("invalid checkout root");
    }
    Ok(root)
}

pub fn select_root(
    args: &[OsString],
    cwd: &Path,
    mut choose: impl FnMut() -> Result<Option<PathBuf>, &'static str>,
    mut retry_invalid: impl FnMut() -> bool,
) -> Result<Option<PathBuf>, &'static str> {
    match args {
        [] => {}
        [flag, path] if flag == "--root" && !path.is_empty() => {
            return validate(&cwd.join(path)).map(Some)
        }
        _ => return Err("unexpected desktop arguments"),
    }
    if let Ok(root) = validate(cwd) {
        return Ok(Some(root));
    }
    loop {
        let Some(selected) = choose()? else {
            return Ok(None);
        };
        match validate(&selected) {
            Ok(root) => return Ok(Some(root)),
            Err(_) if retry_invalid() => continue,
            Err(_) => return Ok(None),
        }
    }
}

#[cfg(windows)]
pub fn choose_folder() -> Result<Option<PathBuf>, &'static str> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows::{
        core::{w, HRESULT, PCWSTR},
        Win32::{
            Foundation::ERROR_CANCELLED,
            System::Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
            },
            UI::Shell::{
                FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName,
                FOS_DONTADDTORECENT, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST,
                FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
            },
        },
    };
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    // SAFETY: all COM interfaces stay on this thread and are dropped before
    // its balanced apartment guard. The selected path is freed after copying.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|_| "folder picker unavailable")?;
        let _apartment = Apartment;
        let result = (|| -> windows::core::Result<Option<PathBuf>> {
            let dialog: IFileOpenDialog =
                CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
            dialog.SetOptions(
                dialog.GetOptions()?
                    | FOS_PICKFOLDERS
                    | FOS_FORCEFILESYSTEM
                    | FOS_PATHMUSTEXIST
                    | FOS_NOCHANGEDIR
                    | FOS_DONTADDTORECENT,
            )?;
            // Begin in this launch's working folder, not a remembered personal folder.
            if let Ok(cwd) = std::env::current_dir() {
                let path: Vec<u16> = cwd.as_os_str().encode_wide().chain(Some(0)).collect();
                let folder: IShellItem = SHCreateItemFromParsingName(PCWSTR(path.as_ptr()), None)?;
                dialog.SetFolder(&folder)?;
            }
            dialog.SetTitle(w!("Choose an Agent Forge checkout"))?;
            dialog.SetOkButtonLabel(w!("Open workspace"))?;
            if let Err(error) = dialog.Show(None) {
                if error.code() == HRESULT::from_win32(ERROR_CANCELLED.0) {
                    return Ok(None);
                }
                return Err(error);
            }
            let selected = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
            let path = OsString::from_wide(selected.as_wide());
            CoTaskMemFree(Some(selected.0.cast()));
            Ok(Some(PathBuf::from(path)))
        })();
        result.map_err(|_| "folder picker unavailable")
    }
}

#[cfg(not(windows))]
pub fn choose_folder() -> Result<Option<PathBuf>, &'static str> {
    Err("folder picker unavailable")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "forge-checkout-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn checkout(&self, linked: bool) -> PathBuf {
            let path = self.0.join("workspace with spaces");
            fs::create_dir_all(path.join("scripts/hearth")).unwrap();
            fs::write(path.join("scripts/hearth/server.ts"), "fixture").unwrap();
            if linked {
                fs::write(path.join(".git"), "gitdir: fixture").unwrap();
            } else {
                fs::create_dir(path.join(".git")).unwrap();
            }
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn valid_current_checkout_needs_no_picker() {
        let fixture = Fixture::new();
        let path = fixture.checkout(false);
        assert_eq!(
            select_root(
                &[],
                &path,
                || panic!("unexpected picker"),
                || panic!("unexpected warning")
            )
            .unwrap(),
            Some(fs::canonicalize(path).unwrap())
        );
    }

    #[test]
    fn an_explicit_root_wins_and_accepts_linked_worktrees() {
        let fixture = Fixture::new();
        let path = fixture.checkout(true);
        for root in [
            path.clone().into_os_string(),
            OsString::from("workspace with spaces"),
        ] {
            let args = [OsString::from("--root"), root];
            assert_eq!(
                select_root(&args, &fixture.0, || panic!("unexpected picker"), || false).unwrap(),
                Some(fs::canonicalize(&path).unwrap())
            );
        }
    }

    #[test]
    fn malformed_or_invalid_explicit_roots_never_fall_back() {
        let fixture = Fixture::new();
        let cwd = fixture.checkout(false);
        for args in [
            vec![OsString::from("--root")],
            vec![OsString::from("--other")],
            vec![OsString::from("--root"), OsString::new()],
            vec![
                OsString::from("--root"),
                fixture.0.join("missing").into_os_string(),
            ],
            vec![
                OsString::from("--root"),
                cwd.clone().into_os_string(),
                OsString::from("extra"),
            ],
        ] {
            assert!(select_root(
                &args,
                &cwd,
                || panic!("unexpected picker"),
                || panic!("unexpected retry")
            )
            .is_err());
        }
    }

    #[test]
    fn cancellation_or_picker_failure_starts_nothing() {
        let fixture = Fixture::new();
        assert_eq!(
            select_root(&[], &fixture.0, || Ok(None), || panic!("unexpected retry")),
            Ok(None)
        );
        assert_eq!(
            select_root(
                &[],
                &fixture.0,
                || Err("unavailable"),
                || panic!("unexpected retry")
            ),
            Err("unavailable")
        );
    }

    #[test]
    fn invalid_selection_requires_a_choice_before_picking_again() {
        let fixture = Fixture::new();
        let checkout = fixture.checkout(false);
        let mut paths = [fixture.0.clone(), checkout.clone()].into_iter();
        let mut warnings = 0;
        let result = select_root(
            &[],
            &fixture.0,
            || Ok(paths.next()),
            || {
                warnings += 1;
                true
            },
        );
        assert_eq!(result.unwrap(), Some(fs::canonicalize(checkout).unwrap()));
        assert_eq!(warnings, 1);
        assert_eq!(
            select_root(&[], &fixture.0, || Ok(Some(fixture.0.clone())), || false),
            Ok(None)
        );
    }
}
