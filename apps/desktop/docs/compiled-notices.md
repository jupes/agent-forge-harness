# Compiled sidecar notices

The Windows candidate build emits a Bun metafile for each of its existing
desktop-host and hearth compile steps. Each fixed metadata file is removed
before its compile, so an old graph cannot qualify a failed build.

The collector conservatively includes installed packages observed in either
input graph, including parsed modules that may later be tree shaken. It records
both graphs and matches each installed package name/version to the frozen
Bun.lock identity and its declared npm SHA-512 integrity. Unsupported sources,
conflicting package originals and non-runtime external imports refuse staging.
Relative input-cycle edges must resolve to captured input modules; any unknown
external import remaining in an emitted output still refuses staging.

Original LICENSE, LICENCE, COPYING and NOTICE files, plus bounded license
directories, are copied byte for byte into legal/npm. The collector rejects
linked legal files, unsafe paths, oversized content and invalid UTF-8. It does
not modify the installed packages. The artifact contains the original files
and COMPILED-DEPENDENCY-INVENTORY.json, with file sizes/hashes, sanitized package
identities, graph labels/hashes and the Bun.lock SHA-256. Machine paths and
package file contents are omitted from the JSON inventory.

Provenance is the frozen install, actual emitted graphs and installed original
legal files. The lock records the declared npm tarball integrity; this layer
does not independently re-download or re-attest each npm tarball.

Packages missing original legal files or a declared license expression remain
named holds. Even complete recorded npm coverage leaves releaseDisposition
as hold until the bundled Bun runtime and installer/NSIS terms, source
obligations and release acceptance are qualified separately. The Cargo
inventory remains a separate locked-crate-archive layer.

Regression coverage includes a real in-memory Bun bundle graph from the frozen
Zod dependency and byte-exact standalone inventory staging. This test neither
executes bundled output nor launches the desktop application.
