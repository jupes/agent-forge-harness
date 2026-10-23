import { expect, test } from "bun:test";
import { codingOutcome } from "./coding-outcome";

const base = {
  provider: "claude",
  version: "2.1.296",
  phase: "failed",
  exit: {
    exitCode: 1,
    timedOut: false,
    stopped: false,
    stderr: "private stderr tail",
  },
} as const;
test("timeout, operator Stop and internal protocol/storage kills retain their distinct actual evidence", () => {
  expect(
    codingOutcome({
      ...base,
      exit: { ...base.exit, timedOut: true, stopped: true },
      protocolFailure: true,
      providerFailure: true,
      reportedCode: "rate_limit",
    }),
  ).toMatchObject({ code: "timed-out", timedOut: true, stopped: true });
  expect(
    codingOutcome({ ...base, exit: { ...base.exit, stopped: true } }),
  ).toMatchObject({ code: "stopped", stopped: true });
  expect(
    codingOutcome({
      ...base,
      exit: { ...base.exit, stopped: true },
      protocolFailure: true,
    }),
  ).toMatchObject({ code: "protocol-error", stopped: true });
  expect(
    codingOutcome({
      ...base,
      exit: { ...base.exit, stopped: true },
      storageFailure: true,
    }),
  ).toMatchObject({ code: "storage-error", stopped: true });
});
test("native error codes support specific outcomes while ordinary words and code-less Codex errors remain generic", () => {
  expect(
    codingOutcome({
      ...base,
      providerFailure: true,
      message: "login expired quota exhausted reset tomorrow",
    }).code,
  ).toBe("provider-error");
  expect(
    codingOutcome({
      ...base,
      providerFailure: true,
      reportedCode: "authentication_failed",
    }).code,
  ).toBe("auth-error");
  expect(
    codingOutcome({
      ...base,
      providerFailure: true,
      reportedCode: "rate_limit",
    }).code,
  ).toBe("rate-limited");
  expect(
    codingOutcome({
      ...base,
      provider: "codex",
      providerFailure: true,
      reportedCode: "rate_limit",
    }).code,
  ).toBe("provider-error");
  expect(
    codingOutcome({
      ...base,
      providerFailure: true,
      reportedCode: "cloud_credential_error",
    }).code,
  ).toBe("provider-error");
  expect(codingOutcome({ ...base, phase: "unknown" }).code).toBe("cli-exit");
  expect(
    codingOutcome({
      ...base,
      phase: "completed",
      exit: { ...base.exit, exitCode: 0 },
    }),
  ).toMatchObject({
    code: "completed",
    stderrTail: { text: "private stderr tail" },
  });
});
