import { expect, test } from "bun:test";
import { LedgerBackupStatus } from "../../apps/desktop/src/LedgerBackupStatus";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";
import { ledgerBackupScheduleSchema } from "./app-hearth-protocol";

test("backup diagnostics distinguish next attempt from current-lifetime completion and unknown publication", () => {
  const schedule = ledgerBackupScheduleSchema.parse({
    phase: "scheduled",
    nextAttemptAt: "2026-11-12T00:00:00.000Z",
    lastAttempt: null,
  });
  const empty = textOf(LedgerBackupStatus({ schedule, keepDays: 14 }));
  expect(empty).toContain("00:00 UTC while Hearth is running");
  expect(empty).toContain(
    "No scheduled backup has been attempted during this Hearth lifetime",
  );
  expect(empty).toContain("2026-11-12T00:00:00.000Z");
  expect(empty).not.toContain("Snapshot and retention completed");
  const completed = textOf(
    LedgerBackupStatus({
      schedule: {
        ...schedule,
        lastAttempt: {
          startedAt: "2026-11-11T00:00:00.000Z",
          outcome: "completed",
        },
      },
      keepDays: 14,
    }),
  );
  expect(completed).toContain("Snapshot and retention completed");
  const unknown = LedgerBackupStatus({
    schedule: {
      ...schedule,
      lastAttempt: {
        startedAt: "2026-11-11T00:00:00.000Z",
        outcome: "unconfirmed",
      },
    },
    keepDays: 14,
  });
  expect(textOf(unknown)).toContain(
    "could not be confirmed. A snapshot may exist",
  );
  expect(
    findAll(unknown, "p").some((node) => attrs(node)["role"] === "status"),
  ).toBe(true);
  expect(textOf(unknown)).toContain(
    "No automatic retry is made for that UTC day",
  );
  expect(findAll(unknown, "button")).toHaveLength(0);
});

test("unavailable and stopped schedules never imply backup health or an active nightly timer", () => {
  expect(
    textOf(LedgerBackupStatus({ schedule: null, keepDays: 14 })),
  ).toContain("Nightly backup schedule unavailable");
  for (const phase of ["inactive", "stopped"] as const) {
    const view = textOf(
      LedgerBackupStatus({
        schedule: { phase, nextAttemptAt: null, lastAttempt: null },
        keepDays: 14,
      }),
    );
    expect(view).toContain("Nightly backup timer is " + phase);
    expect(view).not.toContain("Next scheduled attempt");
  }
  expect(
    ledgerBackupScheduleSchema.safeParse({
      phase: "scheduled",
      nextAttemptAt: null,
      lastAttempt: null,
    }).success,
  ).toBe(false);
  expect(
    ledgerBackupScheduleSchema.safeParse({
      phase: "stopped",
      nextAttemptAt: "2026-11-12T00:00:00.000Z",
      lastAttempt: null,
    }).success,
  ).toBe(false);
});
