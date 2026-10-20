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

#[cfg(windows)]
pub fn startup_retry() -> bool {
    const MB_RETRYCANCEL: u32 = 0x00000005;
    const MB_ICONWARNING: u32 = 0x00000030;
    const MB_DEFBUTTON2: u32 = 0x00000100;
    const IDRETRY: i32 = 4;
    let text: Vec<u16> = "The hearth could not start. The desktop has not connected to your workspace.\r\n\r\nCheck that the app's dashboard and sidecar files are together and that the workspace is available, then choose Retry. Choose Cancel to close the app."
        .encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = "Agent Forge — hearth unavailable"
        .encode_utf16()
        .chain(Some(0))
        .collect();
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
    // No owner window exists until the host supplies a validated launch URL.
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_RETRYCANCEL | MB_ICONWARNING | MB_DEFBUTTON2,
        ) == IDRETRY
    }
}

#[cfg(not(windows))]
pub fn startup_retry() -> bool {
    false
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
