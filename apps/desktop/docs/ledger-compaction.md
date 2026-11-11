# Compact older ledger events

In Settings, check Ledger compaction status, review the acknowledgement, then
choose **Compact older events**. Cancel review clears the acknowledgement and
does no maintenance. Opening Settings, checking status and reconnecting never
start compaction. Each operation requires a new acknowledgement.

The target is the shared machine ledger, across every workspace using it.
Individual events strictly older than 90 days are folded into daily counts by
workspace and event kind. Their individual details are deleted. Events exactly
at the cutoff and newer are kept. This does not promise a smaller database file.

The existing snapshot routine runs before the existing compaction transaction,
using one captured time and the Hearth's bound ledger. Its ordinary UTC-dated
backup can replace the same day's snapshot and prune snapshots older than
14 days. It is not a dedicated immutable recovery copy or a verified restore.
No restore control is provided. SQLite and filesystem work are synchronous;
there is no promised hard IO deadline. The Settings mutex serializes callers
sharing this home; CLI maintenance, other homes and nightly backups remain
independent. The existing CLI, scheduler, retention and ACL rules are unchanged.

Confirmed reports the exact event and distinct-day counts returned by the
transaction, including zero when nothing was eligible. The displayed cutoff
belongs to that operation. A status read is not a new compaction or a health
check of older snapshots. Only the latest Settings receipt is retained, not a
complete operation history or a record of earlier CLI maintenance.

An interrupted or failed action may have published a snapshot or committed
compaction. **Unconfirmed** never means nothing changed. A private durable
pending receipt is verified before upkeep starts. Pending, malformed, missing
initialized history or mismatched ledger identity holds further Settings
compaction across Hearth restart. It never resets itself. Inspect the ledger,
backup and retained receipt before deliberate recovery; there is no reset or
automatic replay endpoint.

A window also preserves its exact pending request in session storage before
sending. Navigation and reload retain that intent. Check status resolves it
only when the same ledger, revision and operation id have an exact completed
receipt. Ready state, a different operation or a superseded receipt does not
resolve an older unknown outcome. A closing window can lose its session
storage; the server's durable pending receipt still holds the ledger.
Unavailable or corrupt window storage disables compaction. Definitive
pre-effect refusal requires a fresh status read and acknowledgement; it never
retries automatically. Restarting Hearth is not a recovery step.

The protected read and audited action accept no path, date or retention
setting. They use the existing gate, operator token, strict bounded body and
audit-before-effect runner. Focused tests use temporary SQLite ledgers and
fake effects only. Native Windows behavior, installation, restoration and
human release acceptance require separate evidence.
