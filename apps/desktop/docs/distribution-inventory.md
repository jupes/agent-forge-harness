# Distribution dependency inventory

The Windows engineering build now derives a native dependency inventory from
the locked Cargo metadata for x86_64-pc-windows-msvc. It walks normal and build
dependencies from agent-forge-desktop, excluding dev-only edges. This is a
conservative source/build closure, not a binary link map.

After the native build, the build runs Cargo metadata with --locked and --quiet.
It may obtain missing already-locked manifests: Cargo filters the resolve graph,
while its packages array still describes all target dependencies. A failed command, incomplete graph, foreign source, ambiguous lock
identity, checksum mismatch, unsafe path, linked legal file, invalid text or
size overflow refuses this inventory and the build. This collector installs
no dependency, launches no product and changes no client configuration.

Each selected package must match the exact registry source, name, version and
package checksum in Cargo.lock and its Cargo-generated .cargo-checksum.json.
Original legal files are read from the corresponding regular registry package
directory and matched against that file map. This uses Cargo's downloaded
source and checksum evidence; it does not independently authenticate a new
registry archive.

Legal texts are copied byte for byte under legal/cargo/<package>-<version>/.
DISTRIBUTION-INVENTORY.json records versions, declared license expressions,
package checksums, legal file paths/lengths/hashes, output locations, lock and
metadata hashes, and explicit missing-coverage holds. It omits source-machine
paths and raw Cargo errors. The outer CANDIDATE.json hashes these staged files.

Missing original legal files or license expressions remain named holds.
The collector preserves expressions such as MIT OR Apache-2.0 literally; it
does not choose terms or certify their legal sufficiency. Root project and
browser notices continue through the existing distribution notice owner.

The inventory currently has releaseDisposition: hold because the bundled Bun
runtime, compiled-sidecar NPM dependency closure and installer/NSIS obligations
still require completion. A generated native inventory is an engineering
artifact and does not close the full 1.0 release-notice requirement. Source
generation and manual/native installation acceptance remain separate.

Focused fixtures cover normal/build versus dev-only closure, exact original
bytes, lock and file mismatch, unsafe paths, missing coverage, Unicode source
names, bounded filesystem reads, non-Windows symbolic-link refusal and staged
artifact contents. Real hosted inventory generation remains unqualified until
the changed-head Windows build produces and verifies it.
