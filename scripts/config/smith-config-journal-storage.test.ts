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
  expect(smithJournalDirectoryName("routing")).toBe(
    "smith-routing-edit-journal",
  );
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

test("same request identity remains isolated between fixed Smith journal stores", async () => {
  const profile = join(scratch.make("smith-family-isolation-"), "profile");
  mkdirSync(profile);
  const create = createSmithConfigJournalStorage(profile, "create"),
    edit = createSmithConfigJournalStorage(profile, "edit"),
    routing = createSmithConfigJournalStorage(profile, "routing"),
    requestId = "eb56db61-e8ac-46c8-8e05-a787754d1019",
    createText = '{"family":"create"}',
    editText = '{"family":"edit"}',
    routingText = '{"family":"routing"}';

  await create.exclusive(async () => {
    create.writeOnce(requestId, "intent.json", createText);
  });
  await edit.exclusive(async () => {
    edit.writeOnce(requestId, "intent.json", editText);
  });
  await routing.exclusive(async () => {
    routing.writeOnce(requestId, "intent.json", routingText);
  });

  for (const [storage, expected] of [
    [create, createText],
    [edit, editText],
    [routing, routingText],
  ] as const) {
    const entries = [...storage.inspect(requestId)!];
    expect(entries.map(({ name }) => name)).toEqual(["intent.json"]);
    expect(storage.read(requestId, entries[0]!, 65_536)).toBe(expected);
    expect(
      [...storage.operations()].map(({ requestId: listed }) => listed),
    ).toEqual([requestId]);
  }
  expect(existsSync(join(profile, "smith-create-journal"))).toBe(true);
  expect(existsSync(join(profile, "smith-edit-journal"))).toBe(true);
  expect(existsSync(join(profile, "smith-routing-edit-journal"))).toBe(true);
});
