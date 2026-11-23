# Configuration transaction boundary

`prepareConfigTransaction` captures the selected target, both canonical rename
addresses and an environment snapshot before the caller awaits anything. It
creates no directories or files. `readConfigTransactionSources` is an optimistic
read for internal review: it returns copied raw bytes and paired revisions, and
does not authorize a later write by itself.

Trusted callers may opt into `maxSourceBytes` during preparation. The captured
private policy applies to both layers at every optimistic/held capture,
pre-publication recheck and post-rename readback. Descriptor size is checked
before allocating a bounded buffer; the same already-open descriptor supplies
at most limit+1 bytes, including growth after its first stat. Existing metadata,
identity and parent fences remain. Omission retains the scalar writer's prior
descriptor read behavior. This is not a public request/CLI option or an IO
deadline, and it does not replace the create coordinator's separate candidate
size check before attempted marking/publication. An over-limit readback after
rename remains attempted/unconfirmed, never a no-effect refusal.

`withConfigTransaction` serializes cooperating writers in the same OS user
through the existing SQLite queue-lock primitive. Its default persistent mutex is
`~/.agent-forge-config-transactions/write.lock.db`, using the actual OS home
captured during preparation. This small coordination-metadata exception is
independent of `LoadOptions.home`, `AGENT_FORGE_HOME`, Agent Forge profile,
selected layer and checkout. Never unlink the mutex. `coordinationRoot` is a
separate trusted internal test seam; it must not become a caller-supplied path.
The bounded acquisition wait does not promise a deadline for synchronous
filesystem IO.

After taking the mutex, the transaction reads both config layers freshly. It
binds bytes/hash, absence, plain-file identity, metadata and canonical parent
anchors. A supplied paired revision must still match. Publication rechecks both
layers and the persistent mutex identity, creates only selected missing parents
as a verified own transition, writes one temporary draft, renames it over the
selected file and verifies the resulting bytes/identity and unchanged other
layer. A publisher can be used once and becomes unusable when its callback ends
or is cancelled. A late callback cannot publish after ownership is released.

Linked, hard-linked, non-file and Windows reparse config leaves deliberately
refuse. This changes the old scalar writer's replace-the-symlink behavior. Parent
aliases are separately canonicalized and anchored; they are not categorically
forbidden. New-file permissions remain the rename draft's permissions, without
an ACL-preservation promise. These checks detect external changes best effort;
they do not form a hostile-account or arbitrary-filesystem-editor boundary.

Failures before any replacement attempt can report refusal. Once replacement
was attempted, failed verification, callback failure or cancellation retains
`ConfigTransactionError.replacementAttempted = true` with an unconfirmed result.
The future coordinator must preserve that distinction instead of claiming
"nothing changed". No durable request receipt, replay, idempotency or complete
Smith creation is provided here.

`setConfigValue` and `runConfigCli` now return promises, and every caller must
await them. Public CLI syntax, JSON envelopes and exit codes remain the same.
Publication `file` fields and the CLI's "written to" path now use the canonical
physical spelling of the rename target. A parent alias or Windows short name may
therefore differ from the supplied path; this output-spelling refinement is
intentional. Legacy disk-reader/get provenance retains its supplied source labels.
Scalar repair still precedes global loading. The scanner preserves comments,
order, BOM and line endings; shared lazy byte-layer validation preserves loader
failure order and the env-pass rule. The synchronous `withProcessHomes` helper
must not wrap an async call: tests that need relocated homes use an owned child
whose startup homes are verified before any write.

The pure `buildSmithCreateCandidate` remains unchanged and creates no mutex or
directories. Later desktop complete-create work should use this same transaction
for fresh paired sources and publication, then separately define its durable
request/recovery, protected dispatch and UI contracts. This child adds none of
those surfaces.

Evidence for agent-forge-harness-cla5.7.6.4 (Serialize cooperating configuration
writers under one transaction lock): the focused same-process matrix passed
124 tests / 621 assertions, including deterministic absent/present parent-alias
publication paths; the separately owned actual Windows scratch matrix
passed four tests / 33 assertions. That matrix proves two profiles and checkout
spellings preserve both changes, actual lock-owner death releases the same
persistent mutex, child-only moved-home writes stay isolated, and an actual
reparse leaf leaves its referent unchanged. Current hosted Linux/Windows and
displaced-isolation checks remain required before readiness; no broad full-suite,
desktop or packaged-native claim is made for this child.
