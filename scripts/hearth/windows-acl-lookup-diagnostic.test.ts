import { expect, test } from "bun:test";
import {
  emitWindowsSidLookupDiagnostic,
  rethrowWindowsSidLookupFailure,
  type WindowsSidLookupDiagnosticInput,
} from "./windows-acl-lookup-diagnostic";
import {
  PWSH_7_EXECUTABLE,
  resolveSddlAliasRuntime,
  validateSddlAliasRuntime,
} from "./windows-sddl-alias-runtime";

const MISSING = Symbol("missing");
const SECRET = "must-not-appear";

function fixture(
  result: Record<string, unknown> = {
    exitCode: null,
    success: false,
    signalCode: "SIGTERM",
    exitedDueToTimeout: false,
    exitedDueToMaxBuffer: false,
    stdout: new Uint8Array(),
    stderr: new Uint8Array(),
    pid: 12345,
    command: SECRET,
    path: SECRET,
  },
  change: Partial<WindowsSidLookupDiagnosticInput> = {},
): WindowsSidLookupDiagnosticInput {
  return { failed: true, alias: "LA", elapsedMs: 125, result, ...change };
}

function capture(input: WindowsSidLookupDiagnosticInput): string[] {
  const rows: string[] = [];
  emitWindowsSidLookupDiagnostic(input, (row) => rows.push(row));
  return rows;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsed(row: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(row);
  } catch {
    return {};
  }
  return isRecord(value) ? value : {};
}

test("writes one bounded fixed row with only the failed lookup facts", () => {
  const rows = capture(fixture());
  expect(rows).toHaveLength(1);
  expect(parsed(rows[0] ?? "")).toEqual({
    phase: "sddl-alias-sid",
    alias: "LA",
    elapsedMs: 125,
    exitCode: null,
    success: false,
    signalCode: "SIGTERM",
    exitedDueToTimeout: false,
    exitedDueToMaxBuffer: false,
    stdoutBytes: 0,
    stderrBytes: 0,
  });
  expect(rows[0]).not.toContain(SECRET);
  expect(
    new TextEncoder().encode(rows[0] ?? "").byteLength,
  ).toBeLessThanOrEqual(2048);
});

test("keeps exit-code null, missing, nonfinite and invalid states distinct", () => {
  const absent = fixture({});
  const explicitUndefined = fixture({ exitCode: undefined });
  const values = [
    parsed(capture(fixture({ exitCode: 7 }))[0] ?? "").exitCode,
    parsed(capture(fixture({ exitCode: null }))[0] ?? "").exitCode,
    parsed(capture(absent)[0] ?? "").exitCode,
    parsed(capture(fixture({ exitCode: Number.NaN }))[0] ?? "").exitCode,
    parsed(capture(explicitUndefined)[0] ?? "").exitCode,
    parsed(capture(fixture({ exitCode: 1.5 }))[0] ?? "").exitCode,
    parsed(capture(fixture({ exitCode: Number.MAX_SAFE_INTEGER + 1 }))[0] ?? "")
      .exitCode,
  ];
  expect(values).toEqual([
    7,
    null,
    "unreported",
    "nonfinite",
    "invalid",
    "invalid",
    "invalid",
  ]);
});

test("preserves each optional boolean as true, false, null, missing or invalid", () => {
  for (const key of ["success", "exitedDueToTimeout", "exitedDueToMaxBuffer"]) {
    const cases: Array<[unknown | typeof MISSING, unknown]> = [
      [true, true],
      [false, false],
      [null, null],
      [MISSING, "unreported"],
      ["bad", "invalid"],
    ];
    for (const [value, expected] of cases) {
      const result: Record<string, unknown> = {};
      if (value !== MISSING) result[key] = value;
      expect(parsed(capture(fixture(result))[0] ?? "")[key]).toBe(expected);
    }
  }
});

test("keeps only known signals and never copies an unknown signal string", () => {
  const signal = (value: unknown | typeof MISSING): unknown => {
    const result: Record<string, unknown> = {};
    if (value !== MISSING) result.signalCode = value;
    const rows = capture(fixture(result));
    return parsed(rows[0] ?? "").signalCode;
  };
  for (const known of ["SIGABRT", "SIGBREAK", "SIGINT", "SIGTERM"])
    expect(signal(known)).toBe(known);
  expect(signal(null)).toBe(null);
  expect(signal(MISSING)).toBe("unreported");
  expect(signal(SECRET)).toBe("other-reported");
  const unknownSignalRow =
    capture(fixture({ signalCode: SECRET.repeat(4096) }))[0] ?? "";
  expect(unknownSignalRow).not.toContain(SECRET);
  expect(
    new TextEncoder().encode(unknownSignalRow).byteLength,
  ).toBeLessThanOrEqual(2048);
  expect(signal(3)).toBe("invalid");
});

test("reports only byte lengths and distinguishes zero, null, missing and invalid output", () => {
  const output = (
    key: "stdout" | "stderr",
    value: unknown | typeof MISSING,
  ): unknown => {
    const result: Record<string, unknown> = {};
    if (value !== MISSING) result[key] = value;
    const rows = capture(fixture(result));
    return parsed(rows[0] ?? "")[
      key === "stdout" ? "stdoutBytes" : "stderrBytes"
    ];
  };
  const channels: Array<"stdout" | "stderr"> = ["stdout", "stderr"];
  for (const channel of channels) {
    expect(output(channel, new Uint8Array())).toBe(0);
    expect(output(channel, new Uint8Array([1, 2]))).toBe(2);
    expect(output(channel, null)).toBe(null);
    expect(output(channel, MISSING)).toBe("unreported");
    expect(output(channel, SECRET)).toBe("invalid");
    for (const length of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const bytes = new Uint8Array();
      Object.defineProperty(bytes, "byteLength", { value: length });
      expect(output(channel, bytes)).toBe("invalid");
    }
  }
});

test("rejects ineligible contexts and reports invalid duration without copying it", () => {
  expect(capture(fixture({}, { failed: false }))).toEqual([]);
  expect(capture(fixture({}, { alias: "A1" }))).toEqual([]);
  const row = parsed(
    capture(fixture({}, { elapsedMs: Number.POSITIVE_INFINITY }))[0] ?? "",
  );
  expect(row.elapsedMs).toBe("invalid");
});

test("rethrows the identical original error when projection or the sink throws", () => {
  const original = new Error(SECRET);
  const hostileResult = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("projection failure");
      },
    },
  );
  const hostileBytes = new Uint8Array();
  Object.defineProperty(hostileBytes, "byteLength", {
    get() {
      throw new Error("byte length failure");
    },
  });
  const failures: Array<
    [WindowsSidLookupDiagnosticInput, (row: string) => void]
  > = [
    [
      fixture(),
      () => {
        throw new Error("sink failure");
      },
    ],
    [fixture(hostileResult), () => undefined],
    [fixture({ stdout: hostileBytes }), () => undefined],
  ];
  for (const [input, sink] of failures) {
    let caught: unknown;
    try {
      rethrowWindowsSidLookupFailure(original, input, sink);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(original);
  }
});

test("rethrows the original error if row serialization throws", () => {
  const original = new Error(SECRET);
  const descriptor = Object.getOwnPropertyDescriptor(JSON, "stringify");
  if (descriptor === undefined)
    throw new Error("JSON.stringify descriptor missing");
  let caught: unknown;
  try {
    Object.defineProperty(JSON, "stringify", {
      ...descriptor,
      value: () => {
        throw new Error("serialization failure");
      },
    });
    try {
      rethrowWindowsSidLookupFailure(original, fixture(), () => undefined);
    } catch (error) {
      caught = error;
    }
  } finally {
    Object.defineProperty(JSON, "stringify", descriptor);
  }
  expect(caught).toBe(original);
});

test("defaults to the system32 PowerShell runtime without probing PowerShell 7", () => {
  const candidates: string[] = [];
  expect(validateSddlAliasRuntime(undefined)).toBe("system32");
  expect(
    resolveSddlAliasRuntime(undefined, (path) => {
      candidates.push(path);
      return false;
    }),
  ).toBe("system32");
  expect(candidates).toEqual([]);
});

test("selects only the fixed PowerShell 7 runtime for the exact enum", () => {
  const candidates: string[] = [];
  expect(validateSddlAliasRuntime("pwsh-7")).toBe("pwsh-7");
  expect(PWSH_7_EXECUTABLE).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
  expect(
    resolveSddlAliasRuntime("pwsh-7", (path) => {
      candidates.push(path);
      return true;
    }),
  ).toBe("pwsh-7");
  expect(candidates).toEqual([PWSH_7_EXECUTABLE]);
});

test("fails closed when the selected fixed PowerShell 7 path is absent", () => {
  const candidates: string[] = [];
  expect(() =>
    resolveSddlAliasRuntime("pwsh-7", (path) => {
      candidates.push(path);
      return false;
    }),
  ).toThrow(
    "The fixed PowerShell 7 executable for SDDL alias lookup does not exist.",
  );
  expect(candidates).toEqual([PWSH_7_EXECUTABLE]);
});

test("rejects every other defined selector without checking an executable", () => {
  const candidates: string[] = [];
  for (const value of ["", "1", "true", " ", "C:\\custom\\pwsh.exe"]) {
    expect(() =>
      resolveSddlAliasRuntime(value, (path) => {
        candidates.push(path);
        return true;
      }),
    ).toThrow("AGENT_FORGE_TEST_SDDL_ALIAS_RUNTIME must be unset or pwsh-7.");
  }
  expect(candidates).toEqual([]);
});
