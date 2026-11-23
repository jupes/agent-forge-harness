import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import {
  projectActivityFiltersSchema,
  projectActivityPageSchema,
} from "./activity-protocol";

const filters = {
  kinds: [],
  provider: null,
  beadId: null,
  sessionId: null,
  runId: null,
  shiftId: null,
  since: null,
  until: null,
};
const base = {
  projectId: "project-015821b4-4b38-4bf3-9326-71ce9c09ff46",
  workspace: "/fixture",
  asOf: "2026-10-23T17:00:00.000Z",
};
const event = {
  id: 1,
  ulid: "01M5N34RC8EKH2SZKG14P4W4AK",
  at: base.asOf,
  kind: "tool.called",
  actor: null,
  beadId: null,
  sessionId: "fixture-session",
  runId: null,
  summary: "Read",
  metadata: [{ key: "tool", value: "Read" }],
};
const page = {
  ...base,
  filters,
  after: 0,
  nextAfter: 1,
  more: false,
  events: [event],
  membershipComplete: true,
  problems: [],
};

test("Activity codecs reject private fields, wrong order, stalled continuations and oversized UTF-8 pages", () => {
  expect(projectActivityPageSchema.safeParse(page).success).toBe(true);
  for (const invalid of [
    { ...page, transcript: "PRIVATE" },
    { ...page, events: [{ ...event, command: "inferred" }] },
    {
      ...page,
      events: [
        { ...event, metadata: [{ key: "input", value: { body: "PRIVATE" } }] },
      ],
    },
    { ...page, after: 1, nextAfter: 1, more: true, events: [] },
    { ...page, events: [event, event] },
    { ...page, nextAfter: 0 },
    {
      ...page,
      nextAfter: 180,
      events: Array.from({ length: 180 }, (_, index) => ({
        ...event,
        id: index + 1,
        metadata: [{ key: "supplied", value: "字".repeat(1000) }],
      })),
    },
  ])
    expect(projectActivityPageSchema.safeParse(invalid).success).toBe(false);
  expect(
    projectActivityPageSchema.safeParse({
      ...page,
      events: [],
      after: 1,
      nextAfter: 7,
      more: true,
    }).success,
  ).toBe(true);
});

test("time ranges compare instants rather than ISO spelling", () => {
  expect(
    projectActivityFiltersSchema.safeParse({
      ...filters,
      since: "2026-10-23T12:00:00Z",
      until: "2026-10-23T12:00:00.500Z",
    }).success,
  ).toBe(true);
  expect(
    projectActivityFiltersSchema.safeParse({
      ...filters,
      since: "2026-10-23T12:00:00.500Z",
      until: "2026-10-23T12:00:00Z",
    }).success,
  ).toBe(false);
});

test("standalone Activity codec bundles for the browser and works with generated code forbidden", async () => {
  const bundle = await Bun.build({
    entrypoints: [`${import.meta.dir}/activity-protocol.ts`],
    target: "browser",
    format: "cjs",
  });
  expect(bundle.success).toBe(true);
  const code = await bundle.outputs[0]?.text();
  if (!code) throw Error("Missing Activity browser bundle");
  expect(code).not.toMatch(/require\(["'](?:node:|bun:)/);
  const context = createContext(
    { window: {}, TextEncoder, module: { exports: {} }, page },
    { codeGeneration: { strings: false, wasm: false } },
  );
  runInContext(code, context);
  expect(
    runInContext(
      "module.exports.projectActivityPageSchema.safeParse(page).success",
      context,
    ),
  ).toBe(true);
});
