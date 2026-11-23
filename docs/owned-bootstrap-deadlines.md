# Owned bootstrap deadline facts

The trusted interactive bootstrap enforces the original granted lifetime. If
that deadline kills its native child while the supervising parent's event loop
is delayed, the result must retain that timeout fact. Neither exit code 1 nor
elapsed time identifies a timeout.

The existing private IPC channel carries one version-1 provider PID frame and
one version-1 terminal frame containing that same PID and a boolean timeout
fact. The parent validates the owned wrapper sender, exact shape, version,
identity and ordering before acknowledging the terminal frame. Duplicate or
foreign frames refuse confirmation. Provider stdout never supplies these facts;
the actual provider inherits neither the IPC channel nor its send capability.

After the actual native child exits, the bootstrap waits at most one second for
the fixed acknowledgement before exiting. That is a control confirmation bound,
not extra provider execution time. The parent independently bounds a missing
terminal receipt after wrapper exit. Its own known Stop, deadline or protocol
interruption remains distinct; unconfirmed normal completion rejects instead of
inventing a successful result. Existing held-job/process-group cleanup and
buffered output draining still precede settlement. Settled handles gain no new
signal authority.

The regression includes an actual native provider/helper and a separate owner
whose event loop is held after partial text. Windows dispatched its parent timer
first even before the repair, so that case is not claimed as a reproduced RED.
The strict trusted-bootstrap terminal-witness case did fail with `timedOut:false`
before implementation and passes afterward. The original Linux CI receipt and
the two independent timer paths establish the timeout-attribution race. Exact
Linux/Windows hosted and packaged checks are recorded separately when completed.
