import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { classify, PAYLOAD, probeChild, type Witness } from "./bun-child-probe";
import { scratchDirs } from "./test-scratch";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

test("requires independent file, exact stdout and exact stderr witnesses", () => {
  const complete: Witness = {
    code: 0,
    stdout: "token\n",
    stderr: "token\n",
    marker: "token",
    timedOut: false,
  };
  expect(classify(complete, "token")).toBe("complete");
  expect(classify({ ...complete, marker: null }, "token")).toBe(
    "witness-mismatch",
  );
  expect(classify({ ...complete, stdout: "" }, "token")).toBe(
    "witness-mismatch",
  );
  expect(classify({ ...complete, stderr: "" }, "token")).toBe(
    "witness-mismatch",
  );
  expect(classify({ ...complete, marker: "stale" }, "token")).toBe(
    "witness-mismatch",
  );
  expect(classify({ ...complete, stdout: "noise\ntoken\n" }, "token")).toBe(
    "witness-mismatch",
  );
  const empty = { ...complete, stdout: "", stderr: "", marker: null };
  expect(classify(empty, "token")).toBe("exit-zero-without-witness");
  expect(classify({ ...empty, code: 1 }, "token")).toBe("nonzero");
  expect(classify({ ...empty, timedOut: true }, "token")).toBe("timeout");
});

for (const mode of ["eval", "file"] as const) {
  test(`${mode}: drains both pipes and checks a unique real file`, async () => {
    const directory = scratch.make("forge-probe-test-");
    const file = join(directory, "payload.ts");
    writeFileSync(file, PAYLOAD);
    const token = `witness-${mode}`;
    const witness = await probeChild(
      process.execPath,
      mode,
      file,
      directory,
      token,
    );
    expect(classify(witness, token)).toBe("complete");
  });
}

test("an empty successful child is detected independently of its exit status", async () => {
  const directory = scratch.make("forge-probe-empty-");
  const file = join(directory, "empty.ts");
  writeFileSync(file, "");
  const witness = await probeChild(
    process.execPath,
    "file",
    file,
    directory,
    "empty",
  );
  expect(witness.code).toBe(0);
  expect(classify(witness, "empty")).toBe("exit-zero-without-witness");
});

test("times out and drains a hung child rather than classifying it as silent success", async () => {
  const directory = scratch.make("forge-probe-timeout-");
  const file = join(directory, "hung.ts");
  writeFileSync(file, "setInterval(() => {}, 1000);");
  const witness = await probeChild(
    process.execPath,
    "file",
    file,
    directory,
    "hung",
    100,
  );
  expect(classify(witness, "hung")).toBe("timeout");
}, 5_000);
