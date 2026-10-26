import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Smith } from "../../types/hearth";
import {
  buildSmithEditCandidate,
  type SmithEditCandidateOutcome,
} from "./write";

const sources = {
  user: { file: "/captured/user/config.toml", bytes: null },
  workspace: { file: "/captured/workspace/agent-forge.toml", bytes: null },
};
const desired: Smith = {
  name: "claude-master",
  provider: "claude",
  model: "reviewed-model",
  effort: "high",
  enabled: false,
  tags: ["rank:master", "reviewed"],
};

function accepted(result: SmithEditCandidateOutcome) {
  expect(result.ok ? null : result.error).toBeNull();
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function refused(result: SmithEditCandidateOutcome, reason: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unexpected candidate");
  expect(result.error).toContain(reason);
}

function request(
  smith: Smith = desired,
  target: "user" | "workspace" = "workspace",
) {
  return { target, name: smith.name, smith };
}

test("built-in Smith overrides are explicit and report target plus effective provenance", () => {
  const candidate = accepted(buildSmithEditCandidate(request(), sources, {}));
  expect(candidate.created).toBe(true);
  expect(candidate.review).toMatchObject({
    name: desired.name,
    targetBefore: null,
    targetAfter: desired,
    effectiveBefore: {
      name: desired.name,
      provider: "claude",
      model: "claude-opus-5-5",
      effort: "high",
      enabled: true,
      tags: ["rank:master"],
    },
    effectiveAfter: desired,
    provenanceBefore: {
      provider: "builtin",
      model: "builtin",
      effort: "builtin",
      enabled: "builtin",
      tags: "builtin",
    },
    provenanceAfter: {
      provider: sources.workspace.file,
      model: sources.workspace.file,
      effort: sources.workspace.file,
      enabled: sources.workspace.file,
      tags: sources.workspace.file,
    },
  });
  expect(Buffer.from(candidate.bytes).toString()).toContain(
    '[smiths.claude-master]\nprovider = "claude"\nmodel = "reviewed-model"\neffort = "high"\nenabled = false\ntags = ["rank:master", "reviewed"]\n',
  );
  expect(candidate.sha256).toBe(
    createHash("sha256").update(candidate.bytes).digest("hex"),
  );
});

test("partial layered definitions are materialized in one target candidate without changing other bytes", () => {
  const userBytes = Buffer.from(
      '[smiths.claude-master]\nmodel = "user-model"\ntags = ["rank:master"]\n',
    ),
    workspaceBytes = Buffer.from(
      "# keep this heading\n[smiths.claude-master]\nenabled = false # keep comment\n[shift]\nrepairs = 4\n",
    ),
    originalUser = Buffer.from(userBytes),
    originalWorkspace = Buffer.from(workspaceBytes),
    value = accepted(
      buildSmithEditCandidate(
        request(),
        {
          user: { ...sources.user, bytes: userBytes },
          workspace: { ...sources.workspace, bytes: workspaceBytes },
        },
        {},
      ),
    );
  expect(value.review.targetBefore).toEqual({ enabled: false });
  expect(value.review.provenanceBefore).toMatchObject({
    provider: "builtin",
    model: sources.user.file,
    effort: "builtin",
    enabled: sources.workspace.file,
    tags: sources.user.file,
  });
  expect(value.review.provenanceAfter).toEqual({
    provider: sources.workspace.file,
    model: sources.workspace.file,
    effort: sources.workspace.file,
    enabled: sources.workspace.file,
    tags: sources.workspace.file,
  });
  expect(value.review.effectiveAfter).toEqual(desired);
  expect(Buffer.from(value.bytes).toString()).toBe(
    '# keep this heading\n[smiths.claude-master]\nenabled = false # keep comment\nprovider = "claude"\nmodel = "reviewed-model"\neffort = "high"\ntags = ["rank:master", "reviewed"]\n[shift]\nrepairs = 4\n',
  );
  expect(userBytes).toEqual(originalUser);
  expect(workspaceBytes).toEqual(originalWorkspace);
});

test("an edit that remains shadowed by a higher layer is refused instead of silently saving", () => {
  const user = Buffer.from('[smiths.claude-master]\nmodel = "user-model"\n'),
    workspace = Buffer.from(
      '[smiths.claude-master]\nmodel = "workspace-model"\n',
    ),
    wanted = { ...desired, model: "new-user-model" };
  refused(
    buildSmithEditCandidate(
      request(wanted, "user"),
      {
        user: { ...sources.user, bytes: user },
        workspace: { ...sources.workspace, bytes: workspace },
      },
      {},
    ),
    "would not make the requested complete Smith effective",
  );
  expect(user.toString()).toContain('model = "user-model"');
  expect(workspace.toString()).toContain('model = "workspace-model"');
});

test("an edit preserves BOM, CRLF, unrelated comments, order and supported unrelated values", () => {
  const bytes = Buffer.from(
    '\uFEFF# untouched\r\n[unknown]\r\nnumber = 41 # exact\r\n[smiths.claude-master]\r\nmodel = "old" # model note\r\neffort = "high"\r\nprovider = "claude"\r\nenabled = true\r\ntags = ["rank:master"] # tags note\r\n',
  );
  const value = accepted(
    buildSmithEditCandidate(
      request(),
      { ...sources, workspace: { ...sources.workspace, bytes } },
      {},
    ),
  );
  expect(Buffer.from(value.bytes).toString()).toBe(
    '\uFEFF# untouched\r\n[unknown]\r\nnumber = 41 # exact\r\n[smiths.claude-master]\r\nmodel = "reviewed-model" # model note\r\neffort = "high"\r\nprovider = "claude"\r\nenabled = false\r\ntags = ["rank:master", "reviewed"] # tags note\r\n',
  );
  expect(bytes.toString()).toContain('model = "old"');
});

test("unknown, prototype and immutable-name-invalid requests are refused", () => {
  refused(
    buildSmithEditCandidate(
      request({ ...desired, name: "missing" }),
      sources,
      {},
    ),
    "unknown existing smith",
  );
  refused(
    buildSmithEditCandidate(
      { ...request(), name: "another-name" },
      sources,
      {},
    ),
    "Invalid input",
  );
  refused(
    buildSmithEditCandidate(
      {
        target: "workspace",
        name: "constructor",
        smith: { ...desired, name: "constructor" },
      },
      sources,
      {},
    ),
    "Invalid input",
  );
});

test("unsupported TOML and first-workspace env-pass changes are refused", () => {
  refused(
    buildSmithEditCandidate(
      request(),
      {
        ...sources,
        workspace: {
          ...sources.workspace,
          bytes: Buffer.from("[unknown]\nvalue = { nested = true }\n"),
        },
      },
      {},
    ),
    "inline table",
  );
  refused(
    buildSmithEditCandidate(
      request(),
      {
        ...sources,
        user: {
          ...sources.user,
          bytes: Buffer.from('[execution.env]\npass = ["TOKEN"]\n'),
        },
      },
      {},
    ),
    "would stop execution.env.pass",
  );
});
