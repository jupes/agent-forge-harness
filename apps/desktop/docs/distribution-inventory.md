# Distribution dependency inventory

The Windows engineering build derives its native inventory from locked Cargo
metadata for x86_64-pc-windows-msvc. It walks normal and build dependencies
from agent-forge-desktop, excluding dev-only edges. This is a conservative
source/build closure, not a binary link map.

Cargo metadata runs with --locked and --quiet, bounded to 120 seconds and
10 MiB of output. It may obtain missing already-locked manifests: Cargo
filters the resolve graph, while its packages array describes all targets.
An incomplete graph, foreign source or ambiguous lock identity refuses the build.

For every selected package, the collector reads its existing registry/cache
.crate archive and verifies the complete compressed bytes against Cargo.lock
SHA256 before interpreting any member. It does not rely on
.cargo-checksum.json: that directory-source file is not a registry-cache
contract or a security proof. The first hosted attempt made that incorrect
assumption, failed closed at adler2, and produced no artifact.

Reads are bounded to 32 MiB compressed and 128 MiB inflated per archive.
Header checksums, member sizes, names, roots and uniqueness are checked before
Bun.Archive.files() reads regular files in memory. Directory and GNU long-name
headers are supported; links, sparse, PAX and other unsupported members refuse
the inventory. Nothing is extracted to disk, installed or executed.

Legal text is limited to 1 MiB per file and 16 MiB across the inventory.
Original legal bytes are copied under legal/cargo/<package>-<version>/.
DISTRIBUTION-INVENTORY.json records versions, declared license expressions,
archive checksums, legal file paths/lengths/hashes, output locations, lock and
metadata hashes, and explicit missing-coverage holds. It omits source-machine
paths. The outer CANDIDATE.json hashes the staged outputs.

Missing original legal files or declared terms remain named holds.
Expressions such as MIT OR Apache-2.0 are preserved literally; the collector
does not choose terms or certify their sufficiency. Root project and browser
notices continue through the existing distribution notice owner.

The inventory retains releaseDisposition: hold. Both actual compiled-sidecar
input graphs now have a separate [NPM inventory](compiled-notices.md), qualified
by hosted staging. Selected pinned [Bun originals](runtime-notices.md) are also
staged for review. Complete runtime/source/relink and installer/NSIS obligations
remain open. None of these layers certifies full release notices.

Focused fixtures cover dependency selection, mismatches, unsafe paths, missing
coverage, Unicode names, exact byte propagation, real cache layout, gzip bounds,
foreign archive roots and sparse-member refusal. An additional inert data check
verified the exact Cargo.lock adler2-2.0.1 archive and all three original legal
files. No local Cargo, native app, provider, client or installer was run.
Actual current-head hosted generation and manual acceptance remain separate.
