import { expect, test } from "bun:test";
import { KeeperReadinessLabel } from "../../apps/desktop/src/KeeperRecovery";
import type { KeeperReadiness } from "../../types/keeper-recovery";
import { textOf } from "../dashboard/ds/vnode";

const ready: KeeperReadiness = {
  connection: "ready",
  allowance: "available",
  canStart: true,
  source: "Provider fixture",
  asOf: "2026-10-22T12:00:00.000Z",
  reason: "The provider report and adapter check succeeded.",
};

test("the readiness heading cannot claim ready when the adapter check or smith selection blocks starting", () => {
  for (const reason of [
    "The Keeper adapter capability check could not be verified.",
    "This smith is disabled. Choose an enabled smith.",
  ]) {
    const heading = KeeperReadinessLabel({
      readiness: { ...ready, canStart: false, reason },
    });
    expect(textOf(heading)).toBe("Keeper unavailable");
  }
  expect(textOf(KeeperReadinessLabel({ readiness: ready }))).toBe(
    "Keeper ready",
  );
});

test("readiness headings retain distinct provider evidence and missing-report states", () => {
  expect(textOf(KeeperReadinessLabel({ readiness: undefined }))).toBe(
    "Keeper smith not verified",
  );
  for (const [readiness, label] of [
    [
      { ...ready, canStart: false, connection: "signed-out" },
      "Provider signed out",
    ],
    [
      { ...ready, canStart: false, connection: "adapter-missing" },
      "Keeper adapter missing",
    ],
    [
      { ...ready, canStart: false, allowance: "exhausted" },
      "Provider allowance exhausted",
    ],
    [
      { ...ready, connection: "unknown", allowance: "unreported" },
      "Provider reporting unavailable",
    ],
  ] satisfies Array<[KeeperReadiness, string]>)
    expect(textOf(KeeperReadinessLabel({ readiness }))).toBe(label);
});
