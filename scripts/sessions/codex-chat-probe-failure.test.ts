import { expect, test } from "bun:test";
import { codexChatProbeFailure } from "./codex-chat-probe-failure";
import { isReadOnlyCapabilityRefusal } from "./read-only-capability-refusal";

test("probe refusal identifies the exact failed read-only probe and settled supervisor facts", () => {
  const error = codexChatProbeFailure(
    "help",
    {
      exitCode: null,
      timedOut: true,
      stopped: true,
      ownedTreeReleased: true,
      stderr: "synthetic private stderr secret",
    },
    true,
  );
  expect(error.message).toBe(
    "The Codex Chat capability probe failed. Probe: help; exit: none; timed out: yes; stopped: yes; invalid output: yes; tree release confirmed: yes.",
  );
  expect(isReadOnlyCapabilityRefusal(error)).toBe(true);
  expect(error.message).not.toContain("synthetic private stderr secret");
  expect(error.cause).toBeUndefined();
  expect(error.message.length).toBeLessThan(240);
});

test("nonzero and invalid-output refusals retain false supervisor facts without inventing a timeout", () => {
  const exit = {
    exitCode: 7,
    timedOut: false,
    stopped: false,
    stderr: "do not disclose",
  };
  expect(codexChatProbeFailure("version", exit, false).message).toBe(
    "The Codex Chat capability probe failed. Probe: version; exit: 7; timed out: no; stopped: no; invalid output: no; tree release confirmed: no.",
  );
  expect(
    codexChatProbeFailure("version", { ...exit, exitCode: 0 }, true).message,
  ).toContain("exit: 0; timed out: no; stopped: no; invalid output: yes");
});
