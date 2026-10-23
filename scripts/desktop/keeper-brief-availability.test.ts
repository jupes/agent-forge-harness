import { expect, test } from "bun:test";
import { KeeperBriefAvailability } from "../../apps/desktop/src/KeeperBrief";
import type { KeeperReadiness } from "../../types/keeper-recovery";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";

const readiness: KeeperReadiness = {
  connection: "unknown",
  allowance: "unreported",
  canStart: false,
  source: "Capability check",
  asOf: "2026-10-23T03:00:00.000Z",
  reason: "The installed Keeper CLI could not be verified.",
};

test("an unavailable brief Refresh explains the provider evidence and links to the same project's Keeper", () => {
  const view = KeeperBriefAvailability({ projectId: "alpha", readiness });
  expect(textOf(view)).toContain(readiness.reason);
  expect(textOf(view)).toContain("Review Keeper readiness");
  expect(findAll(view, "Button").map((node) => attrs(node).href)).toEqual([
    "#/desktop/project/alpha/keeper",
  ]);
  expect(attrs(view).role).toBe("status");
  expect(attrs(view)["data-readiness"]).toBe("unavailable");
});

test("unverified readiness is explicit, while a checked available Keeper needs no refusal message", () => {
  expect(
    textOf(
      KeeperBriefAvailability({ projectId: "alpha", readiness: undefined }),
    ),
  ).toContain("readiness has not been verified");
  expect(
    KeeperBriefAvailability({
      projectId: "alpha",
      readiness: { ...readiness, canStart: true },
    }),
  ).toBeNull();
});
