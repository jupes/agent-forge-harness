import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupEvidenceJson,
  GEMINI_PREVIEW_DIAGNOSTIC_CASE,
  geminiPreviewDiagnosticResources,
  parseRestartManagerPids,
  WINDOWS_CLEANUP_DIAGNOSTIC,
  WINDOWS_CLEANUP_DIAGNOSTIC_CASE,
  windowsCleanupDiagnosticEnabled,
} from "./windows-cleanup-diagnostic";

test("Windows fixture cleanup diagnostics are disabled unless explicitly opted in", () => {
  expect(windowsCleanupDiagnosticEnabled({})).toBe(false);
  expect(
    windowsCleanupDiagnosticEnabled({
      [WINDOWS_CLEANUP_DIAGNOSTIC]: "true",
    }),
  ).toBe(false);
  expect(
    windowsCleanupDiagnosticEnabled({ [WINDOWS_CLEANUP_DIAGNOSTIC]: "1" }),
  ).toBe(false);
  expect(
    windowsCleanupDiagnosticEnabled({
      [WINDOWS_CLEANUP_DIAGNOSTIC]: "1",
      [WINDOWS_CLEANUP_DIAGNOSTIC_CASE]: GEMINI_PREVIEW_DIAGNOSTIC_CASE,
    }),
  ).toBe(true);
});

test("Gemini preview diagnostic registers only the root and its known fixture files", () => {
  const root = "C:/fixture",
    log = join(root, "native.jsonl");
  expect(geminiPreviewDiagnosticResources(root)).toEqual([
    join(
      root,
      process.platform === "win32" ? "inert-gemini.exe" : "inert-gemini",
    ),
    log,
    `${log}.control`,
  ]);
});

test("Restart Manager output is reduced to bounded unique numeric PIDs", () => {
  expect(parseRestartManagerPids("[42,7,42]")).toEqual([7, 42]);
  expect(parseRestartManagerPids("[]")).toEqual([]);
  expect(parseRestartManagerPids("not json")).toBeNull();
  expect(parseRestartManagerPids('[42,"private command line"]')).toBeNull();
  expect(
    parseRestartManagerPids(JSON.stringify(Array(257).fill(1))),
  ).toBeNull();
});

test("cleanup evidence omits arbitrary error text and emits only bounded fields", () => {
  expect(
    cleanupEvidenceJson({
      case: "protected Gemini preview audits before actual read-only native probes and reserves no session",
      operation: "remove-fixture-root-failed",
      target: "C:/fixture",
      errorCode: "EBUSY",
      liveChildCount: 0,
      resources: ["C:/fixture/inert-gemini.exe"],
      rootEntries: ["inert-gemini.exe"],
      rootEntriesTruncated: false,
      lockerPids: [42],
      lockerProbe: "ok",
    }),
  ).not.toContain("private command line");
});
