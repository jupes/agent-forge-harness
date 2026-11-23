import { expect, test } from "bun:test";
import { BUILTIN_DEFAULT_CREW } from "./defaults";
import { buildExecutionEnvCandidate, type ConfigByteSource } from "./write";

const source = (file: string, text: string | null): ConfigByteSource => ({
  file,
  bytes: text === null ? null : Buffer.from(text),
});

test("environment candidate edits names only and preserves the machine file's BOM, comments and CRLF", () => {
  const original =
    '\uFEFF# local policy\r\n[execution.env]\r\npass = ["OLD"] # retained\r\n';
  const sources = {
    user: source("/machine/config.toml", original),
    workspace: source("/checkout/agent-forge.toml", null),
  };
  const result = buildExecutionEnvCandidate(
    { target: "user", names: ["TEAM_TOKEN"] },
    sources,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.error);
  expect(Buffer.from(result.value.bytes).toString()).toBe(
    original.replace('["OLD"]', '["TEAM_TOKEN"]'),
  );
  expect(result.value.names).toEqual(["TEAM_TOKEN"]);
  expect(result.value.provenance).toBe("/machine/config.toml");
  expect(Buffer.from(sources.user.bytes!).toString()).toBe(original);
});

test("environment candidate refuses a user edit whenever a workspace file exists, even if its current names match", () => {
  expect(
    buildExecutionEnvCandidate(
      { target: "user", names: ["WORK"] },
      {
        user: source(
          "/machine/config.toml",
          '[execution.env]\npass = ["USER"]\n',
        ),
        workspace: source(
          "/checkout/agent-forge.toml",
          '[execution.env]\npass = ["WORK"]\n',
        ),
      },
    ).ok,
  ).toBe(false);
});

test("names-only input refuses values, case-ambiguous duplicates and oversized lists", () => {
  const sources = {
    user: source("/machine/config.toml", null),
    workspace: source("/checkout/agent-forge.toml", null),
  };
  for (const names of [
    ["TOKEN=secret"],
    ["Path", "PATH"],
    ["A".repeat(129)],
    Array.from({ length: 257 }, (_, i) => `N${i}`),
  ])
    expect(
      buildExecutionEnvCandidate({ target: "user", names }, sources).ok,
    ).toBe(false);
});

test("an existing empty workspace never inherits machine allowances and can explicitly replace or clear its own list", () => {
  const original = `# workspace policy\n[workflow]\ndefault_crew = ${JSON.stringify(BUILTIN_DEFAULT_CREW)}\n`;
  const sources = {
    user: source(
      "/machine/config.toml",
      '[execution.env]\npass = ["MACHINE_ONLY"]\n',
    ),
    workspace: source("/checkout/agent-forge.toml", original),
  };
  for (const names of [[], ["EXPLICIT_WORKSPACE"]]) {
    const result = buildExecutionEnvCandidate(
      { target: "workspace", names },
      sources,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.error);
    expect(result.value.names).toEqual(names);
    expect(result.value.provenance).toBe("/checkout/agent-forge.toml");
    expect(Buffer.from(result.value.bytes).toString()).toContain(
      original.trimEnd(),
    );
    expect(Buffer.from(result.value.bytes).toString()).not.toContain(
      "MACHINE_ONLY",
    );
  }
});

test("unsupported syntax and invalid UTF-8 refuse without modifying captured source bytes", () => {
  for (const bytes of [
    Buffer.from('[execution]\nenv = { pass = ["BEFORE"] }\n'),
    Buffer.from([0xff, 0xfe]),
  ]) {
    const before = Buffer.from(bytes);
    expect(
      buildExecutionEnvCandidate(
        { target: "workspace", names: ["AFTER"] },
        {
          user: source("/machine/config.toml", null),
          workspace: { file: "/checkout/agent-forge.toml", bytes },
        },
      ).ok,
    ).toBe(false);
    expect(bytes).toEqual(before);
  }
});
