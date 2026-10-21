pub fn retry<T, E>(
    mut attempt: impl FnMut() -> Result<T, E>,
    mut should_retry: impl FnMut(&E) -> bool,
) -> Result<T, E> {
    loop {
        match attempt() {
            Ok(value) => return Ok(value),
            Err(error) if should_retry(&error) => continue,
            Err(error) => return Err(error),
        }
    }
}

pub fn startup_retry() -> bool {
    startup_retry_at(0)
}

pub fn startup_retry_at(owner: usize) -> bool {
    retry_dialog_at(
        owner,
        "Agent Forge — hearth unavailable",
        "The hearth could not start. The desktop has not connected to your workspace.\r\n\r\nCheck that the app's dashboard and sidecar files are together and that the workspace is available, then choose Retry. Choose Cancel to close the app.",
    )
}

pub fn runtime_retry(owner: usize) -> bool {
    retry_dialog_at(
        owner,
        "Agent Forge — connection stopped",
        "The desktop connection to the hearth stopped. The displayed data may be out of date, and workspace actions are unavailable.\r\n\r\nChoose Retry to reconnect to the same checkout. Previously sent actions will not be repeated. Choose Cancel to close the app.",
    )
}

pub fn cleanup_error(owner: usize) {
    message_box_at(
        owner,
        "Agent Forge — recovery unavailable",
        "The desktop could not finish checking the stopped hearth. It will close without starting another connection.\r\n\r\nCheck that the app's dashboard and sidecar files are together, then open the app again. Previously sent actions may have completed; check their outcomes before repeating them.",
        0x00000030,
    );
}

pub fn workspace_retry() -> bool {
    retry_dialog(
        "Agent Forge — choose a checkout",
        "This folder is not an Agent Forge checkout. Nothing has started.\r\n\r\nChoose Retry to select the folder that contains the harness, or Cancel to close the app.",
    )
}

pub fn launch_error() {
    message_box(
        "Agent Forge — workspace unavailable",
        "The desktop could not open this workspace.\r\n\r\nCheck that the checkout and app files are available, then open the app again to choose a checkout. If you supplied a checkout path, check that path before trying again.",
        0x00000030,
    );
}

fn retry_dialog(title: &str, text: &str) -> bool {
    retry_dialog_at(0, title, text)
}

fn retry_dialog_at(owner: usize, title: &str, text: &str) -> bool {
    const MB_RETRYCANCEL: u32 = 0x00000005;
    const MB_ICONWARNING: u32 = 0x00000030;
    const MB_DEFBUTTON2: u32 = 0x00000100;
    const IDRETRY: i32 = 4;
    message_box_at(
        owner,
        title,
        text,
        MB_RETRYCANCEL | MB_ICONWARNING | MB_DEFBUTTON2,
    ) == IDRETRY
}

fn message_box(title: &str, text: &str, flags: u32) -> i32 {
    message_box_at(0, title, text, flags)
}

#[cfg(windows)]
fn message_box_at(owner: usize, title: &str, text: &str, flags: u32) -> i32 {
    let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = title.encode_utf16().chain(Some(0)).collect();
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            owner: *mut std::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            flags: u32,
        ) -> i32;
    }
    // SAFETY: both strings are NUL-terminated and live for the entire modal call.
    // The owner is either zero before startup, or this app's native window.
    unsafe { MessageBoxW(owner as *mut _, text.as_ptr(), title.as_ptr(), flags) }
}

#[cfg(not(windows))]
fn message_box_at(_owner: usize, _title: &str, _text: &str, _flags: u32) -> i32 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn success_needs_no_prompt() {
        assert_eq!(
            retry(|| Ok::<_, &str>(42), |_| panic!("unexpected prompt")),
            Ok(42)
        );
    }

    #[test]
    fn retry_requires_an_explicit_choice_after_each_failure() {
        let attempts = Cell::new(0);
        let prompts = Cell::new(0);
        let result = retry(
            || {
                attempts.set(attempts.get() + 1);
                if attempts.get() < 3 {
                    Err("unavailable")
                } else {
                    Ok(42)
                }
            },
            |error| {
                assert_eq!(*error, "unavailable");
                assert_eq!(attempts.get(), prompts.get() + 1);
                prompts.set(prompts.get() + 1);
                true
            },
        );
        assert_eq!(result, Ok(42));
        assert_eq!(prompts.get(), 2);
    }

    #[test]
    fn cancel_stops_without_another_attempt() {
        let attempts = Cell::new(0);
        let result = retry(
            || {
                attempts.set(attempts.get() + 1);
                Err::<(), _>("unavailable")
            },
            |_| false,
        );
        assert_eq!(result, Err("unavailable"));
        assert_eq!(attempts.get(), 1);
    }
}
