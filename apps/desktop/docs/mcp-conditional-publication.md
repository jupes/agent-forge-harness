# Conditional client configuration publication

This private source producer is not wired to Settings or any real client configuration. Its Windows scratch-file tests must pass before a consumer can use it. MCP registration and native/client acceptance remain open.

The prior last-read-and-rename design could overwrite an independent client edit. The prospective Windows NTFS producer instead opens the exact reviewed file as a transaction writer, checks its file identity, every parent identity and its exact bounded bytes, and writes only the isolated transaction view. It creates a caller-owned receipt in the same transaction. All transacted file handles close before commit; the transaction keeps exclusion through publication. Drop rolls back. Ordinary writes, normal truncation, fallback rename, client shutdown and ACL changes are absent.

Existing files retain their file identity and security descriptor. Missing files and receipts use create-only publication. Local NTFS paths only; reparse points, hard links, encrypted/offline files, remote paths, non-NTFS volumes, malformed paths and unavailable transactions refuse. Input is capped at1MiB, receipt8KiB, path240UTF16units, transaction deadline5seconds, no retry. The deadline bounds transaction lifetime; synchronous local filesystem API calls do not have an independent cancellation guarantee.

A consumer must first durably audit the exact original under its already-qualified owner-private home. It supplies only trusted native target paths and a new fixed receipt there; no renderer path, command, environment or raw client-config selector is allowed. A successful commit plus exact receipt readback is confirmed. Once commit is requested, failure or lost acknowledgment is attempted/unknown. Only matching exact durable receipt recovery can establish earlier confirmation; absence never authorizes blind retry. Client activation/trust/connectivity require separate evidence.

TxF is discouraged by Microsoft and may disappear from future Windows. There is no nontransactional fallback. This source investigation does not establish production support on every Windows/profile/filesystem configuration, and it does not complete the parent feature.

The pinned Bun1.4.2 Windows probe matched the Windows profile initially but followed an altered USERPROFILE even in os.userInfo().homedir. Consequently registration must use SHGetKnownFolderPath(FOLDERID_Profile), independent of ambient HOME/USERPROFILE. Documented CODEX_HOME/CLAUDE_CONFIG_DIR and other known client overrides still need explicit native target composition; an override must never silently write the default profile.

Primary references:
- [TxF isolation and external writers](https://learn.microsoft.com/en-us/windows/win32/fileio/txf-basic-concepts)
- [Transacted filesystem operations and limitations](https://learn.microsoft.com/en-us/windows/win32/fileio/programming-considerations-for-transacted-fileio-)
- [Handle lifetime and commit](https://learn.microsoft.com/en-us/windows/win32/fileio/how-to-use-transactional-ntfs)
- [CreateFileTransactedW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createfiletransactedw)
- [Windows known profile folder](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid)
