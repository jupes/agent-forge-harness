# Update availability in Settings

Choose **Check for updates** in Settings. Opening Settings and receiving
Activity events make no release request. The explicit operator action is
protected and audited before its public read. It sends no GitHub token,
credentials, project path, provider data or private configuration.

The Hearth checks the fixed official repository's GitHub latest stable-release
endpoint. It rejects redirects and limits the whole header/body read to five
seconds and 64 KiB. Concurrent checks share one request; results may be reused
for sixty monotonic seconds. The displayed check time is retained, not minted
again for a reused result. Closing Hearth aborts an outstanding check. There
is no background polling or automatic retry.

The comparison uses the bundled renderer version, not proof of an installed
native binary's version. SemVer precedence handles numeric components,
prerelease identifiers and build metadata. The UI distinguishes a newer
reported stable release, a matching version and a renderer ahead of that
release. The current release-candidate version sorts below its corresponding
stable version. Only valid non-draft, non-prerelease metadata and a stable
SemVer tag are eligible. No remote release body, HTML, assets or executable
links are displayed.

A 404, rate limit, unsupported version, malformed response, timeout or network
failure leaves availability unknown. None is converted into "up to date."
Failed checks retain the last verified release facts, labeled as potentially
out of date. A lost response does not repeat itself. A new explicit Check is
another metadata query, not an installation or provider action.

The validated official release URL is selectable text. Copy it into a browser
to inspect the release; this feature does not change the native navigation
fence or claim supported external-window opening. Automatic installation is
unavailable. The check downloads no package and establishes no package
compatibility, signing, integrity, rollback or native updater qualification.
Those broader Settings/native/release requirements remain open.

Sources: [GitHub release API](https://docs.github.com/en/rest/releases/releases?apiVersion=2026-03-10#get-the-latest-release)
and [Semantic Versioning 2.0.0](https://semver.org/).
Focused fake-network, protected-action, client/state and SemVer tests are
separate from hosted browser coverage and native/human acceptance. No real
network is needed by the test fixtures.
