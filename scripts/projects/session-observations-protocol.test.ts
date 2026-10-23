import { expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";
import {
  projectSessionObservationsSchema,
  sessionObservationDetailSchema,
} from "./session-observations-protocol";

const base = {
  projectId: "project-015821b4-4b38-4bf3-9326-71ce9c09ff46",
  workspace: "/fixture",
  asOf: "2026-10-23T17:00:00.000Z",
};
const observed = {
  sessionId: "native-external",
  workspace: base.workspace,
  lastEventAt: base.asOf,
  kind: "interactive",
};

test("metadata codecs reject private bodies, false ownership and foreign scope rather than silently dropping those fields", () => {
  const page = {
    ...base,
    observations: [observed],
    observationsComplete: true,
    ownership: { available: true, records: [], reason: null },
    problems: [],
  };
  expect(projectSessionObservationsSchema.safeParse(page).success).toBe(true);
  expect(
    projectSessionObservationsSchema.safeParse({ ...page, frames: [] }).success,
  ).toBe(false);
  expect(
    projectSessionObservationsSchema.safeParse({
      ...page,
      observations: [{ ...observed, workspace: "/elsewhere" }],
    }).success,
  ).toBe(false);
  const detail = {
    ...base,
    sessionId: observed.sessionId,
    observation: observed,
    owner: null,
    ownershipAvailable: true,
    ownershipReason: null,
    parent: null,
    after: 0,
    nextAfter: 1,
    more: false,
    activity: [
      {
        id: 1,
        at: base.asOf,
        kind: "tool.called",
        tool: "Read",
        durationMs: null,
        exitCode: null,
      },
    ],
    problems: [],
  };
  expect(sessionObservationDetailSchema.safeParse(detail).success).toBe(true);
  expect(
    sessionObservationDetailSchema.safeParse({
      ...detail,
      activity: [{ ...detail.activity[0], input: { file: "invented-file" } }],
    }).success,
  ).toBe(false);
  expect(
    sessionObservationDetailSchema.safeParse({
      ...detail,
      activity: [{ ...detail.activity[0], id: 2 }],
    }).success,
  ).toBe(false);
  expect(
    sessionObservationDetailSchema.safeParse({
      ...detail,
      observation: { ...observed, sessionId: "another-session" },
    }).success,
  ).toBe(false);
});

test("standalone observation metadata codecs parse under browser CSP without Node, Bun or generated code", async () => {
  const bundle = await Bun.build({
    entrypoints: [`${import.meta.dir}/session-observations-protocol.ts`],
    target: "browser",
    format: "cjs",
  });
  expect(bundle.success).toBe(true);
  const code = await bundle.outputs[0]?.text();
  if (!code) throw Error("Missing observation bundle");
  expect(code).not.toMatch(/require\(["'](?:node:|bun:)/);
  const context = createContext(
    {
      window: {},
      TextEncoder,
      module: { exports: {} },
      page: {
        ...base,
        observations: [observed],
        observationsComplete: true,
        ownership: { available: true, records: [], reason: null },
        problems: [],
      },
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  runInContext(code, context);
  expect(
    runInContext(
      "module.exports.projectSessionObservationsSchema.safeParse(page).success",
      context,
    ),
  ).toBe(true);
});
