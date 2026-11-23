import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Smith } from "../../types/hearth";
import {
  buildSmithCreateCandidate,
  type SmithCreateCandidateOutcome,
} from "./write";

const smith: Smith = {
  name: "new-craft",
  provider: "claude",
  model: "reviewed-model",
  effort: "high",
  enabled: true,
  tags: ["rank:master", "reviewed"],
};

const sources = {
  user: { file: "/captured/missing-parent/config.toml", bytes: null },
  workspace: { file: "/captured/workspace/agent-forge.toml", bytes: null },
};

function accepted(result: SmithCreateCandidateOutcome) {
  expect(result.ok ? null : result.error).toBeNull();
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function refused(result: SmithCreateCandidateOutcome, reason: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unexpected candidate");
  expect(result.error).toContain(reason);
}

test("a complete new Smith arrives together in one valid candidate with effective field provenance", () => {
  const result = buildSmithCreateCandidate({
    target: "workspace",
    smith,
    sources,
    env: {},
  });
  expect(result.ok ? null : result.error).toBeNull();
  if (!result.ok) throw new Error(result.error);
  expect(result.value.effective.config.smiths[smith.name]).toEqual(smith);
  expect(Buffer.from(result.value.bytes).toString()).toBe(
    '[smiths.new-craft]\nprovider = "claude"\nmodel = "reviewed-model"\neffort = "high"\nenabled = true\ntags = ["rank:master", "reviewed"]\n',
  );
  for (const field of ["provider", "model", "effort", "enabled", "tags"]) {
    expect(
      result.value.effective.provenance[`smiths.${smith.name}.${field}`]
        ?.source,
    ).toBe(sources.workspace.file);
  }
});

test("typed quoted dotted names preserve all captured BOM/CRLF/comments/order and supported unknown values", () => {
  const before = Buffer.from(
    '\uFEFF# untouched heading\r\n[unknown]\r\nnumber = 41 # exact comment\r\nitems = [\r\n  "x", # middle\r\n  "y",\r\n]\r\n[shift]\r\nmax_beads = 9\r\n',
  );
  const copy = Buffer.from(before);
  const named = {
    ...smith,
    name: 'crew."quoted".part',
    model: 'm"\\value',
    tags: ["rank:master", "a,b", 'x"y'],
  };
  const value = accepted(
    buildSmithCreateCandidate({
      target: "workspace",
      smith: named,
      env: {},
      sources: {
        ...sources,
        workspace: { ...sources.workspace, bytes: before },
      },
    }),
  );
  expect(Buffer.from(value.bytes).subarray(0, before.length)).toEqual(copy);
  expect(
    Buffer.from(value.bytes).toString().slice(1).replaceAll("\r\n", ""),
  ).not.toContain("\n");
  expect(value.effective.config.smiths[named.name]).toEqual(named);
  expect(value.effective.config.shift.maxBeads).toBe(9);
  expect(before).toEqual(copy);
  expect(value.created).toBe(false);
  expect(value.sha256).toBe(
    createHash("sha256").update(value.bytes).digest("hex"),
  );
  expect(value.sources.workspace).toEqual({
    file: sources.workspace.file,
    byteLength: copy.length,
    sha256: createHash("sha256").update(copy).digest("hex"),
  });
  value.bytes.fill(0);
  value.smith.tags.push("changed output");
  value.effective.config.smiths[named.name]?.tags.push("changed effective");
  expect(before).toEqual(copy);
  expect(named.tags).toEqual(["rank:master", "a,b", 'x"y']);
});

test("absent and empty snapshots remain distinct and only the chosen layer is added", () => {
  const absent = accepted(
    buildSmithCreateCandidate({ target: "user", smith, sources, env: {} }),
  );
  expect(absent.created).toBe(true);
  expect(absent.sources.user).toEqual({
    file: sources.user.file,
    sha256: null,
    byteLength: null,
  });
  expect(absent.effective.files).toEqual([sources.user.file]);
  const empty = accepted(
    buildSmithCreateCandidate({
      target: "user",
      smith,
      env: {},
      sources: {
        ...sources,
        user: { ...sources.user, bytes: new Uint8Array() },
      },
    }),
  );
  expect(empty.created).toBe(false);
  expect(empty.sources.user).toEqual({
    file: sources.user.file,
    sha256: createHash("sha256").update("").digest("hex"),
    byteLength: 0,
  });
  expect(empty.bytes).toEqual(absent.bytes);
  expect(empty.sources.workspace.sha256).toBeNull();
});

test("strict raw UTF-8 refuses replacement repair in either source, even the unedited sibling", () => {
  for (const layer of ["user", "workspace"] as const) {
    for (const bytes of [
      Buffer.from([0xff, 0xfe, 0x61, 0x00]),
      Buffer.from([0x23, 0xc3, 0x28]),
      Buffer.from([0x23, 0xed, 0xa0, 0x80]),
    ]) {
      const copy = Buffer.from(bytes);
      refused(
        buildSmithCreateCandidate({
          target: "workspace",
          smith,
          env: {},
          sources: { ...sources, [layer]: { ...sources[layer], bytes } },
        }),
        "strict UTF-8",
      );
      expect(bytes).toEqual(copy);
    }
  }
});

test("create refuses malformed syntax and every unsupported target scanner construct without mutation", () => {
  const documents = [
    '[unknown]\nvalue = "unterminated\n',
    "[unknown]\nx.y = 1\n",
    "[unknown]\nx = { y = 1 }\n",
    '[unknown]\nx = """multiline"""\n',
    "[[unknown]]\nx = 1\n",
    'smiths = "not a table"\n',
  ];
  for (const text of documents) {
    const bytes = Buffer.from(text);
    const result = buildSmithCreateCandidate({
      target: "workspace",
      smith,
      env: {},
      sources: { ...sources, workspace: { ...sources.workspace, bytes } },
    });
    expect(result.ok).toBe(false);
    expect(bytes.toString()).toBe(text);
  }
});

test("untouched sibling uses the loader dialect and full validation still refuses invalid effective config", () => {
  const user = Buffer.from(
    "[unknown]\nvalue = { supported = true }\n[shift]\nrepairs = 4\n",
  );
  const effective = accepted(
    buildSmithCreateCandidate({
      target: "workspace",
      smith,
      env: { AGENT_FORGE_SMITH: smith.name },
      sources: { ...sources, user: { ...sources.user, bytes: user } },
    }),
  ).effective;
  expect(effective.config.shift.repairs).toBe(4);
  expect(effective.provenance["shift.repairs"]?.source).toBe(sources.user.file);
  expect(effective.config.workflow.defaultCrew).toBe(smith.name);
  expect(effective.provenance["workflow.default_crew"]?.source).toBe("env");
  for (const text of [
    '[benches]\nlow = ["ghost:1"]\n',
    "[shift]\nrepairs = -1\n",
    "[[[",
  ]) {
    refused(
      buildSmithCreateCandidate({
        target: "workspace",
        smith,
        env: {},
        sources: {
          ...sources,
          user: { ...sources.user, bytes: Buffer.from(text) },
        },
      }),
      sources.user.file,
    );
  }
});

test("the first workspace never silently removes the user env pass, while user create preserves it", () => {
  const userBytes = Buffer.from('[execution.env]\npass = ["EXPLICIT_PASS"]\n');
  const withPass = { ...sources, user: { ...sources.user, bytes: userBytes } };
  refused(
    buildSmithCreateCandidate({
      target: "workspace",
      smith,
      sources: withPass,
      env: {},
    }),
    "would stop execution.env.pass",
  );
  const user = accepted(
    buildSmithCreateCandidate({
      target: "user",
      smith,
      sources: withPass,
      env: {},
    }),
  );
  expect(user.effective.config.execution.envPass).toEqual(["EXPLICIT_PASS"]);
  expect(user.effective.provenance["execution.env.pass"]?.source).toBe(
    sources.user.file,
  );
  const alreadyPresent = accepted(
    buildSmithCreateCandidate({
      target: "workspace",
      smith,
      env: {},
      sources: {
        ...withPass,
        workspace: { ...sources.workspace, bytes: Buffer.from("") },
      },
    }),
  );
  expect(alreadyPresent.effective.config.execution.envPass).toEqual([]);
  expect(userBytes.toString()).toBe(
    '[execution.env]\npass = ["EXPLICIT_PASS"]\n',
  );
});

test("create refuses duplicate names from builtin, user and workspace regardless of target", () => {
  const definitions =
    '[smiths.new-craft]\nprovider = "existing"\nmodel = "m"\neffort = "low"\n';
  for (const target of ["user", "workspace"] as const) {
    for (const layer of ["workspace", "user"] as const) {
      const result = buildSmithCreateCandidate({
        target,
        smith,
        env: {},
        sources: {
          ...sources,
          [layer]: { ...sources[layer], bytes: Buffer.from(definitions) },
        },
      });
      expect(result.ok ? null : result.error).toContain("already exists");
    }
    const builtin = buildSmithCreateCandidate({
      target,
      smith: { ...smith, name: "claude-master" },
      sources,
      env: {},
    });
    expect(builtin.ok ? null : builtin.error).toContain("already exists");
  }
});

test("complete Smith has exact own domain fields, and cannot have an object prototype name", () => {
  const malformed = [
    { ...smith, surprise: "extra" },
    { ...smith, rank: "master" },
    { ...smith, enabled: "true" },
    { ...smith, tags: [1] },
    { ...smith, effort: "" },
    { ...smith, model: undefined },
    Object.create(smith),
    ...["constructor", "__proto__", "toString"].map((name) => ({
      ...smith,
      name,
    })),
  ];
  for (const value of malformed) {
    const result = buildSmithCreateCandidate({
      target: "workspace",
      smith: value,
      sources,
      env: {},
    });
    expect(result.ok).toBe(false);
  }
});
