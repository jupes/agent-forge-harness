import { expect, test } from "bun:test";
import { join } from "node:path";
import { liveChildCount } from "../executors/supervisor";
import { verifyProjectShiftEntry } from "./verify-entry";

test("the actual build entry dispatches the closed project shift mode without starting a hearth or bypassing the attended gate", async () => {
  const before = liveChildCount();
  await verifyProjectShiftEntry([
    process.execPath,
    join(import.meta.dir, "..", "hearth", "compiled-entry.ts"),
  ]);
  expect(liveChildCount()).toBe(before);
}, 15_000);
