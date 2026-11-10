import type { LedgerBackupSchedule } from "../../../scripts/desktop/app-hearth-protocol";

export function LedgerBackupStatus({
  schedule,
  keepDays,
}: {
  schedule: LedgerBackupSchedule | null;
  keepDays: number;
}) {
  return (
    <div>
      <p>
        Nightly backups run at 00:00 UTC while Hearth is running. A late wake
        attempts only the current day; missed days are not backfilled. The
        session-start hook also attempts a backup when due. Snapshots older than{" "}
        {keepDays} days are pruned when a new backup is taken.
      </p>
      <p>
        This status covers this Hearth lifetime only. Other workspace Hearths
        may back up the same machine ledger; this is not a global once-per-day
        guarantee or verification of existing backups.
      </p>
      {!schedule ? (
        <p role="status">Nightly backup schedule unavailable.</p>
      ) : (
        <>
          {schedule.phase === "scheduled" && schedule.nextAttemptAt ? (
            <p>
              Next scheduled attempt (UTC):{" "}
              <time dateTime={schedule.nextAttemptAt}>
                {schedule.nextAttemptAt}
              </time>
              .
            </p>
          ) : (
            <p role="status">Nightly backup timer is {schedule.phase}.</p>
          )}
          {!schedule.lastAttempt ? (
            <p role="status">
              No scheduled backup has been attempted during this Hearth
              lifetime.
            </p>
          ) : (
            <p role="status">
              Last scheduled attempt (UTC):{" "}
              <time dateTime={schedule.lastAttempt.startedAt}>
                {schedule.lastAttempt.startedAt}
              </time>
              .{" "}
              {schedule.lastAttempt.outcome === "completed"
                ? "Snapshot and retention completed."
                : "Snapshot or retention could not be confirmed. A snapshot may exist; inspect backups before taking further action. No automatic retry is made for that UTC day."}
            </p>
          )}
        </>
      )}
    </div>
  );
}
