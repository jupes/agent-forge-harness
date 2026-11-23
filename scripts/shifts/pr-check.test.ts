import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_PR_SECTIONS } from "../pr-body";
import { scratchDirs } from "../test-scratch";
import { createShiftPrBodyCheck } from "./pr-check";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
test("compiled shift PR checking keeps the canonical required sections and confines all reads to the retained original body", async () => {
  const root = scratch.make("attended shift PR "),
    bodyDir = join(root, "shift"),
    dir = join(bodyDir, "bead-draft"),
    file = join(dir, "pr-body.md");
  mkdirSync(dir, { recursive: true });
  const check = createShiftPrBodyCheck(bodyDir);
  const body = REQUIRED_PR_SECTIONS.map(
    (section) => `## ${section}\n\nMeasured fixture evidence.\n`,
  ).join("\n");
  writeFileSync(file, body);
  expect(await check(file)).toBeNull();
  writeFileSync(file, "## What Changed\n\nPrivate bounded change.\n");
  expect(await check(file)).toBe(
    "pr:check: missing sections: Why It's Needed, How It Was Tested, Test Evidence, Risk & Rollback, Linked Issues & AC Trace",
  );
  const foreign = join(root, "pr-body.md");
  writeFileSync(foreign, body);
  expect(await check(foreign)).toBe(
    "The retained shift PR body could not be verified.",
  );
  expect(readFileSync(foreign, "utf8")).toBe(body);
  writeFileSync(file, "x".repeat(1_000_001));
  expect(await check(file)).toBe(
    "The retained shift PR body could not be verified.",
  );
  expect(readFileSync(file).byteLength).toBe(1_000_001);
});
