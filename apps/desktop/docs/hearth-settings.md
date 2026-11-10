# Hearth and execution environment in Settings

Open Settings from the global rail or command palette. The Hearth section
uses the same connection and recovery owner as the frame. It shows the
Hearth's actual listening port, API compatibility version and configured ledger
location. The desktop front door can use a different port.

Check Hearth diagnostics performs a protected read. The displayed time belongs
to that read. Refresh failures retain the last verified values and label them
as potentially out of date; a successful diagnostics read does not override
a stopped connection, compatibility mismatch or unknown restart outcome.

Database, write-ahead log and shared-memory sizes are individual logical file
lengths. They are not disk allocation or a transaction-consistent total.
Missing means the fixed file was absent at the read; unknown means its metadata
could not be verified as a regular file. Neither is shown as zero. The read
does not open a database, scan folders or perform maintenance.

The session-start hook attempts a backup once per UTC day when due. Taking a
backup prunes snapshots older than the existing 14-day policy. There is no
nightly timer. Manual compaction folds events older than the existing 90-day
policy into daily summaries. Displaying these policies does not confirm that a
backup or compaction succeeded. This Settings slice offers no maintenance
mutation or policy editor.

Execution environment displays only additional configured names from the
effective Forge configuration, using the existing loader's secure-layer rules.
The executor also has a built-in base allowlist, and provider adapters may
supply their own environment. A configured name does not prove a value exists
or was inherited by an already running agent. Values, process environment,
other configuration fields and raw loader errors are never returned by this
read. Invalid or oversized names make this section unavailable.

Restart Hearth uses the existing desktop restart route. An unknown outcome
disables further restarts in both Settings and the frame, including after
navigation. Check the Hearth and pending actions before acknowledging that
outcome. Acknowledgement is not proof of successful restart.

This slice completes read-only diagnostics and configured-name inspection.
App-wide Settings, scheduled upkeep, native restart settlement and human
Windows release acceptance retain their separate open requirements.

Headless browser evidence at a 1440 × 1000 viewport; the private fixture path
is masked. These captures do not qualify WebView2 or human Windows acceptance.

![Hearth Settings in dark appearance](screenshots/hearth-settings-dark.png)

![Hearth Settings in light appearance](screenshots/hearth-settings-light.png)
