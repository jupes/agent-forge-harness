# Complete Smith creation contract

This is the interface and state-machine checkpoint for
agent-forge-harness-cla5.7.6.5 (Create complete Smith configurations through the
protected backend). Browser-safe types/codecs, the trusted bounded-FD
transaction extension, journal, coordinator, and protected routes are
implemented with focused no-child tests. The desktop consumer now exposes a
create-only candidate review and original-receipt recovery flow; its browser
to real scratch-config end-to-end proof remains a separate gate.

## Public domain input

The selected design accepts one complete existing `Smith` value and a target
layer, `user` or `workspace`. Preview takes `{target, smith}`. Create additionally
takes a lowercase request UUID and `expectedRevision: {version: 1, user,
workspace}`. Both layer tokens are lowercase SHA-256 hashes of the full
server-derived `ConfigFileRevision`, including absence, canonical address,
parent/leaf identity, metadata and bytes. A token is never a path selector.

Requests reject unknown fields, caller paths, TOML patches, runtime options and
incomplete Smiths. Existing domain validation is shared; provider/model/effort
remain exact configuration strings, with no installed-support inference or
normalization. Prototype-owned Smith names refuse. The canonical request string
has a fixed versioned field order and retains tag order and exact values. Only
this new domain hash is defined; existing provider launch hashes do not change.

The operator-only endpoints are POST `/config/smiths/preview`, action
`smith.config.preview`; POST `/config/smiths/creates`, action
`smith.config.create`; and GET `/smiths/creates/:requestId`. Existing
origin/token/body/validation/audit-before-effect order remains authoritative.
Audit metadata contains only the operation identity and selected layer, never
raw TOML, Smith bodies or environment values.

## Desktop create-only review

The Smiths route offers a complete Smith form for the user or workspace layer.
Review shows the server-selected target path, candidate digest and byte length,
both opaque paired revisions, all five field provenance sources and the exact
new Smith. Editing any field discards the prior preview. Create is an explicit
second action and sends the exact reviewed request once under its saved UUID.
This surface does not edit existing Smiths, choose defaults, or change weighted
benches.

The desktop app root owns the create client so route changes do not discard
saved request identities. It retains only UUID, target, input digest and local
scope metadata in browser storage, then checks the same protected original on
startup. Confirmed and refused receipts remain inspectable. A missing,
malformed, generic 404/503, or held server response remains held and offers
only an explicit check of that original UUID; it never triggers a resend or
replacement identity. Browser persistence is guarded by a shared origin lock.

## Review and historical response

Preview returns the server-derived physical target for display, paired tokens,
candidate SHA-256/byte length/created flag, and the new Smith's relevant effect.
The name is absent before creation; after contains the complete Smith and the
five existing field provenance sources. All five sources must be the selected
target. No unrelated effective config map or raw document is returned. The
candidate remains the unchanged `buildSmithCreateCandidate` implementation.

A protected original receipt contains the exact parsed request, its UUID,
server-computed canonical input hash, owner-scope hash, creation time and one
strict result. The codec correlates the original UUID, target, both revision
tokens, complete Smith, candidate and publication. Hash shape is validated by
the browser codec; computing and verifying private original/input/owner hashes
is the backend's separate responsibility. Merely matching a hash string is not
proof that an operation ran.

- `held` carries a saved stage (`intent`, `prepared`, `attempted` or
  `unconfirmed`), never a claim that a writer is currently live. Intent has no
  prepared preview. Prepared/attempted require their exact preview. Unconfirmed
  may lack it if evidence could not be saved.
- `confirmed` requires the exact prepared preview, publication file/created/hash
  and completed time. It means that this operation's publication was read back
  and its completed receipt durably verified. It is historical even if current
  config later changes.
- `refused` carries a fixed pre-attempt reason, refusal time and any previously
  prepared preview. It is permitted only after the owning producer has settled
  and been fenced before attempted-marker saving began.

No result grants replay or provider authority. GET and exact duplicate Create
never publish, reapply, resume an orphan or derive completion from current
before/after bytes. A missing or unreadable original is not proof that a
possibly sent request had no effect. A downstream browser retains bounded
UUID/scope metadata, not full private originals, and holds uncertain identities
after a generic refusal or404.

## Trusted owner and lock ordering

Capture a frozen owner selector before awaiting: the canonical served checkout
and directory identity, private profile namespace, and normalized logical
config selectors derived solely from trusted served root/config home. Config
value environment is explicitly `{}`, matching the current protected config
read. Do not refresh this selector by loading current TOML during original
lookup. The actual physical rename target and paired anchors are captured
separately during fresh admission. Foreign owner context cannot read or reuse a
UUID even if its public body is identical.

Use a private per-profile journal mutex **first**, followed by the existing
OS-user-global config mutex. Scalar CLI takes only the global mutex. Never
acquire a journal lock from inside a global config callback. Bind persistent
journal mutex identity before waiting and after acquisition, never unlink it,
and bound the small SQLite metadata file before opening it.

Strict original lookup, including the under-journal-lock duplicate recheck,
precedes mutable config preparation/loading. This matters because the existing
transaction captures current config before its work callback; placing duplicate
lookup only in that callback would break historical reads when current config
is now corrupt. GET takes neither lock and performs no migration, file creation,
phase update or config read, including when its private directory is absent or
the retained data is corrupt/future-versioned.

## Once-only publication and failure truth

For a genuinely new UUID, save/read back its immutable intent under private
ownership. Prepare fresh canonical config addresses, then take the global
mutex. Under both locks, compare both revision tokens and build the unchanged
pure candidate. Save/read back prepared target/revision/candidate/review evidence.
Save/read back the attempted marker **before** calling the existing single-use
publisher. After verified publication, save/read back the completed receipt
while both locks remain held; release global ownership before private ownership.

Intent/prepared orphans remain held. Once attempted-marker saving has begun,
every failure remains held/unconfirmed unless a durable completed receipt is
read back, including a marker whose persistence could not be confirmed and a
rename that reports failure. Matching current desired or original bytes never
proves who wrote or proves absence of an earlier effect. Terminal confirmed or
settled pre-attempt refused receipts are immutable. A failed terminal save does
not permit inventing that terminal outcome on GET or service recreation.

Keep the production body synchronous after global ownership is granted: no
provider, network, command or arbitrary awaited callback. Acquisition aborts
must fence the publisher before lock release. Never report a no-effect refusal
while queued work can later publish. Any deferred test seam must recheck current
owner/generation immediately before the real save, so late work cannot replace
a terminal refusal or use an expired publisher. Existing linked/reparse/hardlink,
parent-transition, paired revision, env-pass and scalar-repair rules remain.

## Bounds and required transaction extension

Fixed bounds are not public options:16,000 encoded UTF-8 request bytes; complete
Smith name/provider/effort128 UTF-16 units, model512, tags64 by256;1MiB per raw
config source and candidate;64KiB encoded private record and public response;
1024 units per diagnostic path;1000 retained UUID records without eviction;64KiB
private SQLite mutex metadata. Strict schemas also bound JSON escaping and
UTF-8 expansion, not just JavaScript string lengths.

Before private allocation, check file type/identity and byte size, then use the
existing bounded private reader. Count with a bounded directory iterator and
preserve all corrupt/future/unknown files. Do not fetch unbounded SQLite blobs.
Store only the original, owner selector/hash, before evidence, candidate
hash/length, relevant review and receipt. Full candidate/config bytes are not
needed because an orphan is never reconstructed for execution.

The transaction extension adds optional trusted `maxSourceBytes` to prepared
private transaction state. Undefined preserves the scalar writer's behavior.
The create backend supplies the fixed1MiB limit. Every optimistic/held capture,
recheck and publication readback must check descriptor size before allocation
and read at most limit+1 bytes **from that same descriptor**, including growth
after the first stat. Retain all metadata/identity/parent fences. No public field
or CLI flag can change the bound. Preview creates no config/mutex/intent file or
directory; the existing metadata-only operator audit is the sole write exception.

## Verification status

Pure tests cover strict domain inputs, encoded bounds, literal canonical bytes,
original/preview/publication correlation, held-stage truth, browser bundling
without Node-only journal code, exact operator paths/status handling, complete
candidate presentation and held-identity controls. The backend's service and
compiled-entry tests cover durable receipt behavior and no replay across
recreation. This consumer checkpoint has not run its browser end-to-end flow;
the click-to-real-scratch-config proof and current hosted PR checks remain
required before the feature is ready.

Edit, weighted bench and default changes remain outside this create-only UI.
