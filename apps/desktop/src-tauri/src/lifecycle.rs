/// Ownership shared by the native watchdog and app exit handler. A late restart
/// cannot install a child after shutdown or replace an already supervised child.
pub struct Lifecycle<T> {
    child: Option<T>,
    stopped: bool,
}

impl<T> Lifecycle<T> {
    pub fn new(child: T) -> Self {
        Self {
            child: Some(child),
            stopped: false,
        }
    }

    pub fn stopped(&self) -> bool {
        self.stopped
    }

    pub fn take_failed(&mut self, mut failed: impl FnMut(&mut T) -> bool) -> Option<T> {
        if !self.stopped && self.child.as_mut().is_some_and(&mut failed) {
            self.child.take()
        } else {
            None
        }
    }

    pub fn install(&mut self, child: T) -> Result<(), T> {
        if self.stopped || self.child.is_some() {
            Err(child)
        } else {
            self.child = Some(child);
            Ok(())
        }
    }

    pub fn shutdown(&mut self) -> Option<T> {
        self.stopped = true;
        self.child.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_an_unexpected_exit_once_and_accepts_one_replacement() {
        let mut host = Lifecycle::new(10);
        assert_eq!(host.take_failed(|_| false), None);
        assert_eq!(host.take_failed(|_| true), Some(10));
        assert_eq!(host.take_failed(|_| panic!("already removed")), None);
        assert_eq!(host.install(20), Ok(()));
        assert_eq!(host.install(30), Err(30));
        assert_eq!(host.shutdown(), Some(20));
    }

    #[test]
    fn shutdown_never_reports_a_crash_or_accepts_a_late_restart() {
        let mut host = Lifecycle::new(10);
        assert_eq!(host.shutdown(), Some(10));
        assert!(host.stopped());
        assert_eq!(
            host.take_failed(|_| panic!("shutdown is not a crash")),
            None
        );
        assert_eq!(host.install(20), Err(20));
        assert_eq!(host.shutdown(), None);
    }
}
