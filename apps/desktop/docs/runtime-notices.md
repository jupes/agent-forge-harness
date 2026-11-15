# Bundled Bun runtime originals

The portable engineering build stages 32 original upstream files under
legal/bun/ and records their exact provenance in
RUNTIME-DEPENDENCY-INVENTORY.json. The checked-in source is
third-party/bun-1.4.2/INVENTORY.json. Every original retains its upstream
repository, revision, path, Git blob SHA1, byte length and SHA256. Selected
native/build components also identify the Bun build-definition blob from
bun-v1.4.2. The collector verifies both hashes before copying any original.

The compiler must report Bun 1.4.2 with revision prefix 744846f84, matching
the pinned build runtime. Reads require bounded regular UTF8 files, refuse
linked originals/parents and duplicate Windows paths, and preserve all bytes.
There is no build-time network fetch, archive extraction or execution of
the collected source header. The outer CANDIDATE.json hashes staged files.

This is a conservative, selected source/build review set. Node's root license,
for example, carries a broader source notice collection; copying it does not
assert that every named component is linked into our binaries. Root license
files can themselves point to additional files. No alternative license is
selected by the collector.

The manifest deliberately retains releaseDisposition: hold. Remaining work
includes full Windows runtime membership and file-specific notices, Bun's
complete own MIT grant, Rust/polyfill/generated-source and patch mapping,
zstd/SQLite and other named components, corresponding-source and build/relink
obligations, and actual NSIS terms and installer payload qualification.
WebKit's LGPL text and upstream links alone do not establish fulfillment of
source or relinking requirements.

Cargo originals and the actual compiled-sidecar NPM input inventories are
separate layers described in [distribution inventory](distribution-inventory.md)
and [compiled notices](compiled-notices.md). These collected bytes prepare
the independent content review; they do not certify complete release notices.
