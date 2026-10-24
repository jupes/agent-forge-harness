import { expect, test } from "bun:test";
import { SmithVerificationBody } from "../../apps/desktop/src/SmithVerificationTask";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";
import { APPRENTICE_VERIFICATION } from "../smith-verification";

test("verification facts render supplied prose inertly and never turn tracker status into capability or mutation controls", () => {
  const view = SmithVerificationBody({
    retry() {},
    state: {
      open: true,
      loading: false,
      error: "",
      data: {
        workspace: "/served/root",
        checkedAt: "2026-10-23T00:00:00Z",
        task: {
          id: APPRENTICE_VERIFICATION,
          title: "<script>pending</script>",
          status: "open",
          priority: 0,
          description: "[close](javascript:close())",
          acceptanceCriteria: "Owner verification",
          notes: "<img onerror=close()>",
          updatedAt: null,
        },
      },
    },
  });
  expect(textOf(view)).toContain("Recorded priorityP0");
  expect(textOf(view)).toContain(
    "does not certify live model or effort support",
  );
  expect(textOf(view)).toContain("<script>pending</script>");
  expect(textOf(view)).toContain("[close](javascript:close())");
  for (const tag of ["script", "img", "a", "input", "textarea", "select"])
    expect(findAll(view, tag)).toHaveLength(0);
  expect(findAll(view, "Button").map(textOf)).toEqual([
    "Refresh verification task",
  ]);
});

test("verification pending and failed reads stay explicit, with duplicate reads disabled while pending", () => {
  const pending = SmithVerificationBody({
    retry() {},
    state: { open: true, loading: true, error: "", data: null },
  });
  expect(attrs(pending)["aria-busy"]).toBe(true);
  expect(textOf(pending)).toContain("Reading the verification task");
  expect(attrs(findAll(pending, "Button")[0])["disabled"]).toBe(true);
  const failed = SmithVerificationBody({
    retry() {},
    state: {
      open: true,
      loading: false,
      error: "Tracker read unavailable",
      data: null,
    },
  });
  expect(
    findAll(failed, "p").some((node) => attrs(node)["role"] === "alert"),
  ).toBe(true);
  expect(textOf(failed)).toContain("Retry verification read");
  expect(textOf(failed)).not.toContain("Recorded status");
});
