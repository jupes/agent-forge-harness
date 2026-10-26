import { expect, test } from "bun:test";
import {
  classifyWaitResult,
  cleanupWithOptionalDiagnostic,
  fixedProviderPrepareResources,
  fixtureProcessIdentities,
  holdFixtureProcesses,
  type ProbeProcessApi,
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

test("fixture capture closes all handles after partial-open and sample failures without leaking them", () => {
  const executable = "C:\\fixture\\codex.exe",
    identities = [
      { relation: "root" as const, pid: 20, parentPid: null, executable },
      { relation: "helper" as const, pid: 21, parentPid: 20, executable },
    ],
    closed: string[] = [],
    api: ProbeProcessApi<string> = {
      open(pid) {
        return pid === 20 ? "root-handle" : null;
      },
      executable() {
        return executable;
      },
      creationTime() {
        return "creation-20";
      },
      wait() {
        throw new Error("injected sample failure");
      },
      close(handle) {
        closed.push(handle);
      },
    },
    capture = holdFixtureProcesses(identities, api),
    report = capture.sampleAndClose();
  expect(report).toEqual([
    {
      relation: "root",
      pid: 20,
      parentPid: null,
      state: "access-unknown",
      creationTime: "creation-20",
    },
    {
      relation: "helper",
      pid: 21,
      parentPid: 20,
      state: "access-unknown",
      creationTime: null,
    },
  ]);
  expect(closed).toEqual(["root-handle"]);
  expect(JSON.stringify(report)).not.toContain("root-handle");
  expect(JSON.stringify(report)).not.toContain(executable);
  capture.close();
  expect(closed).toEqual(["root-handle"]);
});

test("fixture capture closes every opened handle when one native sample fails", () => {
  const executable = "C:\\fixture\\codex.exe",
    identities = [
      { relation: "root" as const, pid: 20, parentPid: null, executable },
      { relation: "helper" as const, pid: 21, parentPid: 20, executable },
    ],
    closed: string[] = [],
    api: ProbeProcessApi<string> = {
      open(pid) {
        return `handle-${pid}`;
      },
      executable() {
        return executable;
      },
      creationTime(handle) {
        return handle === "handle-20" ? "creation-20" : "creation-21";
      },
      wait(handle) {
        if (handle === "handle-20") throw new Error("injected wait error");
        return 0;
      },
      close(handle) {
        closed.push(handle);
      },
    };
  const report = holdFixtureProcesses(identities, api).sampleAndClose();
  expect(report.map((row) => row.state)).toEqual(["access-unknown", "exited"]);
  expect(closed).toEqual(["handle-20", "handle-21"]);
  expect(JSON.stringify(report)).not.toContain("handle-");
  expect(JSON.stringify(report)).not.toContain(executable);
});

test("diagnostic resource builder permits only the fixed fixture image and record", () => {
  const root = "C:\\fixture",
    resources = fixedProviderPrepareResources(
      root,
      `${root}\\codex.exe`,
      `${root}\\provider.json`,
    );
  expect(resources.relativeNames).toEqual(["codex.exe", "provider.json"]);
  expect(() =>
    fixedProviderPrepareResources(
      root,
      `${root}\\other.exe`,
      `${root}\\provider.json`,
    ),
  ).toThrow("fixture pair");
});

test("default-off cleanup preserves the one existing cleanup call and emits no diagnostics", () => {
  let cleanups = 0,
    reports = 0;
  cleanupWithOptionalDiagnostic(
    false,
    () => {
      cleanups++;
    },
    () => {
      reports++;
    },
  );
  expect({ cleanups, reports }).toEqual({ cleanups: 1, reports: 0 });
});

test("opt-in cleanup emits one post-cleanup report and preserves the original failure", () => {
  let cleanups = 0;
  const successReports: Array<unknown | null> = [];
  cleanupWithOptionalDiagnostic(
    true,
    () => {
      cleanups++;
    },
    (error) => successReports.push(error),
  );
  expect({ cleanups, successReports }).toEqual({
    cleanups: 1,
    successReports: [null],
  });

  const original = Object.assign(new Error("fixture remove failed"), {
      code: "EPERM",
    }),
    failureReports: Array<unknown | null> = [];
  expect(() =>
    cleanupWithOptionalDiagnostic(
      true,
      () => {
        cleanups++;
        throw original;
      },
      (error) => failureReports.push(error),
    ),
  ).toThrow(original);
  expect(cleanups).toBe(2);
  expect(failureReports).toEqual([original]);
});
