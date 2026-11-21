# Repository content

This repository owns the Forge workflow, agent configuration, shared runtime,
Hearth, browser dashboard and their tests. Desktop UI, native packaging and
release tooling live in [agent-forge-desktop](https://github.com/jupes/agent-forge-desktop).
Shared runtime modules used by the desktop remain here.

Commit reusable source, public product documentation, deterministic test fixtures
and required third-party licenses. Keep research and plans about other products
in those products or in ignored local working directories.

Credentials, provider homes, local configuration, tracker databases, generated
snapshots, build output and session evidence stay outside the tracked tree.
Environment examples must contain placeholders only. Ignore rules protect common
local files; they do not sanitize files already tracked by Git.

Use synthetic project data and generic paths in fixtures and screenshots. Inspect
new screenshots for local paths, account details and unrelated project content
before committing them. Retain malformed credential examples only where they
exercise redaction or rejection behavior; never use working credentials in tests.

A current-tree cleanup does not erase earlier commits or copies in forks and
clones. Any discovered live credential requires revocation independently of Git
cleanup. History changes require a coordinated migration for both repositories.
