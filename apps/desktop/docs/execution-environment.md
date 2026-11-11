# Execution environment controls

Settings edits `execution.env.pass`, the additional names that a future
config-reading executor launch may inherit. It never reads or edits environment
values. The fixed base names come from the running Hearth's
`BASE_ENV_ALLOWLIST` and remain allowed. A configured name does not prove a
value exists, was inherited by an existing agent, or applies to an adapter that
constructs a different environment. Saving does not change the parent process
or running agents.

The host captures its trusted connected checkout and machine configuration
selectors. When a workspace configuration exists, only that workspace's list
applies; machine security names are never inherited. Otherwise Settings edits
the machine file without creating a workspace file. The target file, actual
effective source and current names are shown before review. This is the
connected configuration, not an editor for another saved Scope.

Enter at most 256 names of at most 128 characters, one per line. Names start
with a letter or underscore and contain only letters, digits and underscores.
Case-insensitive duplicates and `NAME=value` input are refused. Existing invalid
or oversized names are unavailable rather than normalized or truncated. Cancel
writes nothing. Review shows the complete replacement and target; Save is a
separate explicit action. Existing comments, order, BOM and line endings are
preserved by the configuration writer's scanner, parsed-effect comparison and
loader validation. Unsupported file constructs require a manual edit.

The protected operator table audits `app.environment.save` before effect. Public
input contains an operation UUID, owner hash, paired revision hashes, global
journal revision and names, never a file selector. Both config layers and the
selected target are checked freshly under the existing OS-user configuration
transaction mutex. A workspace appearing or disappearing refuses the request;
the server never silently changes its reviewed target. The writer retains its
plain-file, parent identity, paired-source, one-publication and post-rename
readback fences. Its synchronous filesystem work has no separate IO deadline;
the existing mutex acquisition wait is bounded to one second.

A private `environment-v1` journal under the existing actual-OS-user config
coordination root records and verifies pending intent before config publication.
It is shared across Forge homes, roots and installations. Any failure after
intent publication was attempted is an unknown outcome, even if current names
match; pending history blocks all cooperating environment Settings writers.
Missing, corrupt or partial initialized history is never reset. GET creates no
directory, reconciles no operation and writes no configuration. Closing aborts
and joins complete queued save operations. The scalar CLI uses the same config
mutex but does not consume this feature's intent journal; arbitrary editors are
also outside it. External changes are detected best effort, not prevented as an
OS compare-and-set or hostile-account boundary.

The window preserves the exact request in session storage before sending.
Navigation/reload and unknown replies never replay it. Only its exact completed
record, including original names, owner and revisions, can clear uncertainty.
The latest global record is bounded and can replace an older completed record;
an overwritten record cannot confirm an older lost reply. A verified receipt
describes that publication at that time, separately from a subsequent current
config read. Later external changes retain the draft and historical receipt for
another explicit review. Failed, contradictory or regressed refreshes hold Save.
Unavailable session storage also holds writes.

Source reads are capped at 1 MiB per layer; requests at 40 KiB, private records
at 48 KiB and status data at 96 KiB. The browser's bounded operator transport
also allows 2 KiB for the envelope. Errors are generic so config values and
parser/provider details cannot enter the renderer, audit subject or diagnostics.
The existing window stream triggers reads only; mounting and reconnecting never
save.

Focused tests use temporary config/coordination homes, fake publication failures
and inert provider/tracker fixtures. Hosted browser cases cover keyboard,
focus, Cancel, review, pending, minimum width, unsupported state and lost-reply
recovery. These checks do not qualify real provider inheritance, native Windows
behavior, installation or human acceptance. Those release requirements remain
separate; no installer or native attempt is admitted by this source change.
