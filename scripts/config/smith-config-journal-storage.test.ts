import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../test-scratch";
import {
  createSmithConfigJournalStorage,
  smithJournalDirectoryName,
} from "./smith-config-journal-storage";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

test("journal families map only to their fixed, isolated namespaces", () => {
  expect(smithJournalDirectoryName("create")).toBe("smith-create-journal");
  expect(smithJournalDirectoryName("edit")).toBe("smith-edit-journal");
  expect(() => smithJournalDirectoryName("custom")).toThrow(
    "The private Smith journal family is invalid.",
  );
  expect(() => smithJournalDirectoryName(null)).toThrow(
    "The private Smith journal family is invalid.",
  );
});

test("invalid family is rejected before profile resolution or filesystem changes", () => {
  const absentProfile = join(scratch.make("smith-family-invalid-"), "absent");
  expect(() =>
    // Runtime callers are checked even when they bypass the TypeScript union.
    createSmithConfigJournalStorage(absentProfile, "custom" as "create"),
  ).toThrow("The private Smith journal family is invalid.");
  expect(existsSync(absentProfile)).toBe(false);
});

test("same request identity remains isolated between create and edit stores", async () => {
  const profile = join(scratch.make("smith-family-isolation-"), "profile");
  mkdirSync(profile);
  const create = createSmithConfigJournalStorage(profile, "create"),
    edit = createSmithConfigJournalStorage(profile, "edit"),
    requestId = "eb56db61-e8ac-46c8-8e05-a787754d1019";

  await create.exclusive(async () => {
    create.writeOnce(requestId, "intent.json", '{"family":"create"}');
  });
  expect([...create.inspect(requestId)!].map(({ name }) => name)).toEqual([
    "intent.json",
  ]);
  expect(edit.inspect(requestId)).toBeNull();
  expect([...edit.operations()]).toEqual([]);
  expect(existsSync(join(profile, "smith-edit-journal"))).toBe(false);
});
