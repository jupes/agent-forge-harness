import { expect, test } from "bun:test";
import {
  capturePackagedStopWitness,
  packagedStopRecord,
  recordPackagedStopWitness,
  reportPackagedStopFailure,
} from "./attended-shift-smoke";

test("stop witness is active-only, skips guard-root, and allowlists fields", () => {
  const source = {
    reason: "growth-over-cap" as const,
    initialTotal: 1,
    capturedTotal: 65,
    retainedCount: 1,
    capturedMemberCount: 1,
    privatePath: "must-not-escape",
  };
  expect(capturePackagedStopWitness(false, "terminate", source)).toBeNull();
  expect(capturePackagedStopWitness(true, "guard-root")).toBeNull();
  const witness = capturePackagedStopWitness(true, "deadline", source);
  expect(witness?.generationFailure).toEqual({
    reason: "growth-over-cap",
    initialTotal: 1,
    capturedTotal: 65,
    retainedCount: 1,
    capturedMemberCount: 1,
  });
  const accountingSource = {
    activeCount: 2,
    retainedCount: 1,
    capturedMemberCount: 1,
    initialTotal: 2,
    capturedTotal: 3,
    pid: 412,
    path: "private",
    body: "private",
  };
  const accounting = capturePackagedStopWitness(
    true,
    "accounting",
    undefined,
    accountingSource,
  );
  expect(accounting?.accountingFailure).toEqual({
    activeCount: 2,
    retainedCount: 1,
    capturedMemberCount: 1,
    initialTotal: 2,
    capturedTotal: 3,
  });
  expect(JSON.stringify(accounting)).not.toMatch(/412|private/);
  expect(JSON.stringify(witness)).not.toContain("privatePath");
});

test("each labeled stop gets its own first active witness and ordinal", () => {
  const first = {
    invocation: 1,
    label: "before-restart" as const,
    witness: null,
  };
  const next = {
    invocation: 2,
    label: "after-recovery" as const,
    witness: null,
  };
  recordPackagedStopWitness(first, "deadline");
  recordPackagedStopWitness(first, "terminate");
  recordPackagedStopWitness(next, "terminate");
  expect(first.witness?.phase).toBe("deadline");
  expect(next.witness?.phase).toBe("terminate");
  expect(
    packagedStopRecord({
      invocation: 1,
      label: first.label,
      outcome: "refused",
      witness: first.witness,
    }),
  ).toMatchObject({
    invocation: 1,
    label: "before-restart",
    phase: "deadline",
  });
  expect(
    packagedStopRecord({
      invocation: 2,
      label: next.label,
      outcome: "refused",
      witness: next.witness,
    }),
  ).toMatchObject({
    invocation: 2,
    label: "after-recovery",
    phase: "terminate",
  });
  expect(
    packagedStopRecord({
      invocation: 3,
      label: "finally-cleanup",
      outcome: "no-owned-host",
    }),
  ).toMatchObject({
    invocation: 3,
    label: "finally-cleanup",
    outcome: "no-owned-host",
  });
  recordPackagedStopWitness(null, "terminate");
  expect(next.witness?.phase).toBe("terminate");
});

test("stop record distinguishes no owner from unavailable refusal evidence", () => {
  expect(
    packagedStopRecord({
      invocation: 3,
      label: "finally-cleanup",
      outcome: "no-owned-host",
    }),
  ).toMatchObject({ outcome: "no-owned-host", phase: null, failure: null });
  expect(
    packagedStopRecord({
      invocation: 1,
      label: "before-restart",
      outcome: "refused",
    }),
  ).toMatchObject({
    outcome: "refused",
    phase: "unavailable",
    failure: "other",
    generationFailure: null,
    accountingFailure: null,
  });
});

test("stop diagnostics cannot mask or disclose the original failure", () => {
  const original = Object.assign(new Error("private fixture path"), {
    privatePath: "C:\\private\\fixture",
  });
  const record = packagedStopRecord({
    invocation: 2,
    label: "after-recovery",
    outcome: "refused",
    witness: capturePackagedStopWitness(true, "deadline"),
  });
  let line = "",
    caught: unknown;
  try {
    reportPackagedStopFailure(original, record, (value) => {
      line = value;
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(original);
  expect(line).toContain('"phase":"deadline"');
  expect(line).not.toContain("private");
  let writerFailure: unknown;
  try {
    reportPackagedStopFailure(original, record, () => {
      throw Error("writer");
    });
  } catch (error) {
    writerFailure = error;
  }
  expect(writerFailure).toBe(original);
});
