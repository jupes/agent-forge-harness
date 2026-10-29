import { afterEach, expect, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../test-scratch";
import {
  createRunInspectionReader,
  RUN_INSPECTION_LIMITS,
} from "./inspection-read";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());
function fixture() {
  const root = scratch.make("run-inspection-");
  const directory = join(root, ".tmp", "work", "forge-runs");
  mkdirSync(directory, { recursive: true });
  const state = {
    schemaVersion: 2,
    slug: "alpha",
    epic: "alpha-epic",
    phase: "research",
    completed: [],
    artifacts: {},
    updatedAt: "2026-10-23T12:00:00.000Z",
  };
  const file = join(directory, "alpha.json");
  writeFileSync(file, JSON.stringify(state));
  return { root, directory, state, file };
}

test("the strict reader keeps canonical legacy defaults without rewriting bytes or trusting a filename/state mismatch", () => {
  const { root, file, state } = fixture();
  const bytes = JSON.stringify({ ...state, schemaVersion: undefined });
  writeFileSync(file, bytes);
  expect(createRunInspectionReader(root).read()[0]).toMatchObject({
    slug: "alpha",
    schemaVersion: 2,
  });
  expect(readFileSync(file, "utf8")).toBe(bytes);
  const changed = JSON.stringify({ ...state, slug: "foreign" });
  writeFileSync(file, changed);
  expect(() => createRunInspectionReader(root).read()).toThrow("Run source");
  expect(readFileSync(file, "utf8")).toBe(changed);
});

test("future, malformed, invalid UTF-8 and over-limit run files are refused and preserved", () => {
  const { root, file, state } = fixture();
  for (const bytes of [
    Buffer.from(JSON.stringify({ ...state, schemaVersion: 3 })),
    Buffer.from('{"slug":'),
    Buffer.from([0xff, 0xfe, 0x7b]),
    Buffer.alloc(RUN_INSPECTION_LIMITS.fileBytes + 1, 0x20),
    Buffer.from(JSON.stringify({ ...state, completed: ["invented"] })),
  ]) {
    writeFileSync(file, bytes);
    expect(() => createRunInspectionReader(root).read()).toThrow("Run source");
    expect(readFileSync(file)).toEqual(bytes);
  }
});

test("hard-linked state and a linked run directory cannot enter a protected read", () => {
  const first = fixture();
  linkSync(first.file, join(first.directory, "second.json"));
  expect(() => createRunInspectionReader(first.root).read()).toThrow(
    "Run source",
  );
  const second = fixture();
  const moved = join(second.root, "retained-runs");
  renameSync(second.directory, moved);
  symlinkSync(
    moved,
    second.directory,
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(() => createRunInspectionReader(second.root).read()).toThrow(
    "Run source",
  );
  expect(readFileSync(join(moved, "alpha.json"), "utf8")).toBe(
    JSON.stringify(second.state),
  );
});

test("artifact reading derives the canonical path, returns complete UTF-8 and refuses NUL or oversized content", () => {
  const { root, directory, state } = fixture();
  const artifact = "plans/research/alpha.md";
  const body = "# Exact research\n";
  mkdirSync(join(root, "plans", "research"), { recursive: true });
  writeFileSync(join(root, artifact), body);
  writeFileSync(
    join(directory, "alpha.json"),
    JSON.stringify({
      ...state,
      completed: ["research"],
      artifacts: { research: artifact },
    }),
  );
  const reader = createRunInspectionReader(root);
  expect(reader.readArtifact("research", "alpha")).toEqual({
    artifact,
    content: body,
    bytes: Buffer.byteLength(body),
  });
  const unsafe = "# unsafe\u0000text";
  writeFileSync(join(root, artifact), unsafe);
  expect(() => reader.readArtifact("research", "alpha")).toThrow(
    "Run source",
  );
  expect(readFileSync(join(root, artifact), "utf8")).toBe(unsafe);
  writeFileSync(
    join(root, artifact),
    Buffer.alloc(RUN_INSPECTION_LIMITS.fileBytes + 1, 0x61),
  );
  expect(() => reader.readArtifact("research", "alpha")).toThrow(
    "Run source",
  );
  writeFileSync(join(root, artifact), body);
  linkSync(join(root, artifact), join(root, "plans", "research", "linked.md"));
  expect(() => reader.readArtifact("research", "alpha")).toThrow(
    "Run source",
  );
});

test("a captured served checkout cannot be retargeted between construction and reading", () => {
  const container = scratch.make("run-retarget-");
  const root = join(container, "checkout");
  const directory = join(root, ".tmp", "work", "forge-runs");
  mkdirSync(directory, { recursive: true });
  const bytes = JSON.stringify({
    schemaVersion: 2,
    slug: "alpha",
    phase: "research",
    completed: [],
    artifacts: {},
    updatedAt: "2026-10-23T12:00:00.000Z",
  });
  writeFileSync(join(directory, "alpha.json"), bytes);
  const reader = createRunInspectionReader(root);
  const retained = join(container, "retained");
  // Both resolved paths stay within this fixture's checked OS-temp container.
  renameSync(root, retained);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "alpha.json"), bytes);
  expect(() => reader.read()).toThrow("Run source");
  expect(
    readFileSync(join(retained, ".tmp/work/forge-runs/alpha.json"), "utf8"),
  ).toBe(bytes);
  expect(readFileSync(join(directory, "alpha.json"), "utf8")).toBe(bytes);
});

test("a finite directory/file budget refuses a run collection instead of silently truncating it", () => {
  const { root, directory, state } = fixture();
  for (let index = 0; index < RUN_INSPECTION_LIMITS.files; index++)
    writeFileSync(
      join(directory, `extra-${index}.json`),
      JSON.stringify({ ...state, slug: `extra-${index}` }),
    );
  expect(() => createRunInspectionReader(root).read()).toThrow("Run source");
});
