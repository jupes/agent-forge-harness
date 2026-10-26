import { expect, test } from "bun:test";
import {
  classifyWaitResult,
  fixtureProcessIdentities,
  parseRestartManagerReport,
} from "./provider-prepare-diagnostics";

test("probe cleanup diagnostics bind root/helper PIDs from one complete fixture record", () => {
  const executable = "C:\\fixture\\codex.exe";
  expect(
    fixtureProcessIdentities(
      `${JSON.stringify({ kind: "version", pid: 10, childPid: null })}\n${JSON.stringify({ kind: "help", pid: 20, childPid: 21 })}\n`,
      executable,
    ),
  ).toEqual([
    { relation: "root", pid: 20, parentPid: null, executable },
    { relation: "helper", pid: 21, parentPid: 20, executable },
  ]);
  expect(() =>
    fixtureProcessIdentities(
      `${JSON.stringify({ kind: "help", pid: 20, childPid: 21 })}`,
      executable,
    ),
  ).toThrow("incomplete record");
  expect(() =>
    fixtureProcessIdentities(
      `${JSON.stringify({ kind: "help", pid: 20 })}\n`,
      executable,
    ),
  ).toThrow("PID pair");
});

test("probe cleanup state preserves access-unknown instead of guessing process exit", () => {
  expect(classifyWaitResult(0)).toBe("exited");
  expect(classifyWaitResult(258)).toBe("alive");
  expect(classifyWaitResult(5)).toBe("access-unknown");
});

test("Restart Manager diagnostic parsing emits only fixed relative resources and bounded PIDs", () => {
  const root = "C:\\fixture";
  expect(
    parseRestartManagerReport(
      JSON.stringify({ ok: true, pids: [21, 20, 21] }),
      root,
      [`${root}\\codex.exe`, `${root}\\provider.json`],
    ),
  ).toEqual({
    state: "complete",
    resources: ["codex.exe", "provider.json"],
    pids: [21, 20],
  });
  expect(
    parseRestartManagerReport(
      JSON.stringify({
        ok: true,
        pids: Array.from({ length: 129 }, (_, index) => index + 1),
      }),
      root,
      [`${root}\\codex.exe`, `${root}\\provider.json`],
    ).state,
  ).toBe("unavailable");
  expect(
    parseRestartManagerReport(
      '{"ok":true,"pids":[1],"names":["secret"]}',
      root,
      [`${root}\\provider.json`],
    ),
  ).toMatchObject({ state: "unavailable", pids: [] });
});
