import { expect, test } from "bun:test";
import {
  SmithCreateFormView,
  SmithCreateReceiptsView,
} from "../../apps/desktop/src/SmithCreateForm";
import type {
  SmithCreateClientState,
  SmithCreateEntry,
} from "../../apps/desktop/src/smith-create-client";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";

const smith = {
  name: "smith-review",
  provider: "codex",
  model: "gpt-example-exact",
  effort: "high",
  enabled: true,
  tags: ["one", "two"],
};
const revision = {
  version: 1 as const,
  user: "a".repeat(64),
  workspace: "b".repeat(64),
};
const preview = {
  version: 1 as const,
  target: "workspace" as const,
  file: "C:\\fixture\\agent-forge.toml",
  expectedRevision: revision,
  candidate: { sha256: "c".repeat(64), byteLength: 412, created: false },
  review: {
    before: null,
    after: smith,
    provenance: {
      provider: "C:\\fixture\\agent-forge.toml",
      model: "C:\\fixture\\agent-forge.toml",
      effort: "C:\\fixture\\agent-forge.toml",
      enabled: "C:\\fixture\\agent-forge.toml",
      tags: "C:\\fixture\\agent-forge.toml",
    },
  },
};

function state(
  candidate: SmithCreateClientState["preview"] = null,
): SmithCreateClientState {
  return {
    target: "workspace",
    smith,
    preview: candidate,
    previewing: false,
    creating: false,
    entries: [],
    activeRequestId: null,
    serverDiscoveryReady: true,
    notice: "",
  };
}

test("create review exposes every complete Smith field and requires a matching candidate", () => {
  const noCandidate = SmithCreateFormView({
    state: state(),
    canWrite: true,
    canStart: true,
    onDraft() {},
    onPreview() {},
    onCreate() {},
  });
  const buttons = findAll(noCandidate, "button");
  expect(textOf(noCandidate)).toContain("Provider");
  expect(textOf(noCandidate)).toContain("Model");
  expect(textOf(noCandidate)).toContain("Effort");
  expect(textOf(noCandidate)).toContain("Enabled");
  expect(textOf(noCandidate)).toContain("Tags");
  expect(textOf(noCandidate)).toContain("Workspace configuration");
  expect(attrs(buttons[1])["disabled"]).toBe(true);

  const reviewed = SmithCreateFormView({
    state: state(preview),
    canWrite: true,
    canStart: true,
    onDraft() {},
    onPreview() {},
    onCreate() {},
  });
  expect(textOf(reviewed)).toContain("C:\\fixture\\agent-forge.toml");
  expect(textOf(reviewed)).toContain("Candidate SHA-256");
  expect(textOf(reviewed)).toContain("Paired user revision");
  expect(textOf(reviewed)).toContain("Paired workspace revision");
  expect(textOf(reviewed)).toContain("provider source");
  expect(textOf(reviewed)).toContain("tags source");
  expect(attrs(findAll(reviewed, "button")[1])["disabled"]).toBe(false);

  const edited = SmithCreateFormView({
    state: { ...state(preview), smith: { ...smith, model: "changed" } },
    canWrite: true,
    canStart: true,
    onDraft() {},
    onPreview() {},
    onCreate() {},
  });
  expect(attrs(findAll(edited, "button")[1])["disabled"]).toBe(true);
});

test("held original UI offers only an explicit same-UUID check, never a resend", () => {
  const held: SmithCreateEntry = {
    identity: {
      requestId: "18da5c95-3218-439c-a33d-e5662465f505",
      scope: "http://127.0.0.1:8888/",
      target: "workspace",
      inputHash: "d".repeat(64),
    },
    request: null,
    receipt: null,
    state: "held",
    checking: false,
    notice: "The original receipt is not available yet.",
    serverIdentity: null,
    remoteOnly: false,
    continueAllowed: false,
  };
  const noWrite = SmithCreateReceiptsView({
    entries: [held],
    canWrite: false,
    creating: false,
    onCheck() {},
    onContinue() {},
    onRetire() {},
  });
  expect(textOf(noWrite)).toContain("Outcome held");
  expect(textOf(noWrite)).toContain(held.identity.requestId);
  expect(textOf(noWrite)).toContain("never sent again automatically");
  expect(findAll(noWrite, "button")).toHaveLength(1);
  expect(attrs(findAll(noWrite, "button")[0])["disabled"]).toBe(false);

  const checked: string[] = [];
  const writable = SmithCreateReceiptsView({
    entries: [held],
    canWrite: true,
    creating: false,
    onCheck: (id) => checked.push(id),
    onContinue() {},
    onRetire() {},
  });
  const checkButton = findAll(writable, "button")[0];
  const onClick = attrs(checkButton)["onClick"];
  if (typeof onClick !== "function") throw Error("Check action is missing");
  onClick({} as never);
  expect(checked).toEqual([held.identity.requestId]);
  expect(textOf(writable)).not.toContain("Create Smith");
  expect(textOf(writable)).not.toContain("Resend");
});

test("terminal original entries remain inspectable without check controls", () => {
  const terminal: SmithCreateEntry = {
    identity: {
      requestId: "28da5c95-3218-439c-a33d-e5662465f506",
      scope: "http://127.0.0.1:8888/",
      target: "user",
      inputHash: "e".repeat(64),
    },
    request: null,
    receipt: null,
    state: "refused",
    checking: false,
    notice: "Refused before publication.",
    serverIdentity: null,
    remoteOnly: false,
    continueAllowed: false,
  };
  const view = SmithCreateReceiptsView({
    entries: [terminal],
    canWrite: true,
    creating: false,
    onCheck() {},
    onContinue() {},
    onRetire() {},
  });
  expect(textOf(view)).toContain("Refused before publication");
  expect(findAll(view, "button")).toHaveLength(0);
});
