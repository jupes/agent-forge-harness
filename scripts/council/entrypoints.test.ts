import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCouncilCli } from "./cli";
import { buildContextPack } from "./context";

const roots: string[] = [];
function temp() {
  const root = mkdtempSync(join(tmpdir(), "council-entrypoints-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("CLI finds bundled profiles outside the harness and never overwrites a run", async () => {
  const cwd = temp();
  const stdout: string[] = [];
  const io = {
    cwd,
    readStdin: async () => "Review this plan and its evidence",
    stdout: (line: string) => {
      stdout.push(line);
    },
    stderr: () => {},
  };
  expect(
    await runCouncilCli(
      ["stdin", "--run-id", "external-project", "--json"],
      io,
    ),
  ).toBe(0);
  let parsed: {
    ok: boolean;
    data: { run: { context: { evidence: unknown[] } } };
  };
  try {
    parsed = JSON.parse(stdout.join(""));
  } catch {
    throw new Error("CLI output is not JSON");
  }
  expect(parsed.ok).toBe(true);
  expect(parsed.data.run.context.evidence).toHaveLength(1);
  stdout.length = 0;
  expect(
    await runCouncilCli(
      ["stdin", "--run-id", "external-project", "--json"],
      io,
    ),
  ).toBe(1);
  expect(stdout.join("")).toContain('"ok": false');
});

test("binary research files are rejected rather than presented as reviewed text", () => {
  const cwd = temp();
  writeFileSync(join(cwd, "study.pdf"), "%PDF-1.4");
  expect(() =>
    buildContextPack({ kind: "file", cwd, path: "study.pdf" }),
  ).toThrow("export this document");
  writeFileSync(join(cwd, "binary.dat"), Buffer.from([0, 255, 1]));
  expect(() =>
    buildContextPack({ kind: "file", cwd, path: "binary.dat" }),
  ).toThrow("UTF-8 text");
});
