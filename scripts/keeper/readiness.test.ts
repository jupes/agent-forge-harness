import { expect, test } from "bun:test";
import { keeperReadiness } from "./readiness";

test("a failed usage report remains unreported and does not claim exhaustion or sign-out", () => {
  const value = keeperReadiness({ adapter: true, checked: true });
  expect(value.connection).toBe("unknown");
  expect(value.allowance).toBe("unreported");
  expect(value.canStart).toBe(true);
  expect(value.reason).toContain("not reported");
});

test("specific auth and exhaustion evidence are different from a missing adapter", () => {
  const base = { adapter: true, checked: true };
  expect(keeperReadiness({ ...base, connection: "signed-out" })).toMatchObject({
    connection: "signed-out",
    canStart: false,
  });
  expect(keeperReadiness({ ...base, allowance: "exhausted" })).toMatchObject({
    allowance: "exhausted",
    canStart: false,
  });
  expect(keeperReadiness({ adapter: false, checked: false })).toMatchObject({
    connection: "adapter-missing",
    allowance: "unreported",
    canStart: false,
  });
  expect(keeperReadiness({ adapter: true, checked: false }).canStart).toBe(
    false,
  );
});
