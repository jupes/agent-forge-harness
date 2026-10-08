import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LedgerEventInput } from "../../types/hearth";
import { validateOperatorEnvelope } from "../hearth/validate";
import { appendEvent } from "./append";
import { formatTable, parseAuditArgs } from "./audit-cli";
import { closeLedger } from "./db";
import { queryEvents } from "./query";
import { resolveCheckout } from "./workspace";

const temporary: string[] = [];

/** A fake checkout to run the CLI from and a ledger home, both under a path with a space. */
function sandbox(): { cwd: string; home: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "ledger test "));
  temporary.push(root);
  const cwd = join(root, "check out");
  const home = join(root, "forge home");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  return { cwd, home, path: join(home, "ledger.db") };
}

afterEach(() => {
  closeLedger();
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const CLI = join(import.meta.dir, "audit-cli.ts");

/** The parent's environment minus anything that names a live session or ledger. */
function childEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(CLAUDE_|AGENT_FORGE_|FORGE_)/.test(key)) continue;
    env[key] = value;
  }
  env.AGENT_FORGE_HOME = home;
  return env;
}

async function audit(
  box: { cwd: string; home: string },
  args: string[],
): Promise<{ exitCode: number; stdout: string }> {
  const child = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: box.cwd,
    env: childEnv(box.home),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  return { exitCode: await child.exited, stdout };
}

function event(
  workspace: string,
  extra: Partial<LedgerEventInput> = {},
): LedgerEventInput {
  // justification: the spread only overrides correlation fields of a tool.called event.
  return {
    kind: "tool.called",
    workspace,
    payload: { tool: "Bash", argsHash: "sha256:ab12" },
    ...extra,
  } as LedgerEventInput;
}

describe("parseAuditArgs", () => {
  test("an unknown flag, a flag with no value, an unknown kind and a non-ISO --since are each refused", () => {
    const cases: Array<[string[], string]> = [
      [["--bogus"], "--bogus"],
      [["--bead"], "--bead"],
      [["--run", "--json"], "--run"],
      [["--kind", "tool.called,tool.exploded"], "tool.exploded"],
      [["--since", "yesterday"], "yesterday"],
      [["--limit", "0"], "--limit"],
      [["--limit", "many"], "--limit"],
      [["--after-id", "-1"], "--after-id"],
      [["--bead-exact"], "--bead-exact"],
      [["stray"], "stray"],
      [["--backup", "--run", "x"], "--backup"],
    ];
    for (const [argv, offender] of cases) {
      const parsed = parseAuditArgs(argv);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain(offender);
    }
  });

  test("every documented flag is read into the query it describes", () => {
    const parsed = parseAuditArgs([
      "--bead",
      "b-1",
      "--bead-exact",
      "--run",
      "r-1",
      "--session",
      "s-1",
      "--since",
      "2026-10-05T12:00:00Z",
      "--kind",
      "tool.called,gate.ran",
      "--limit",
      "5",
      "--after-id",
      "10",
      "--all-workspaces",
      "--json",
    ]);
    expect(parsed).toEqual({
      ok: true,
      value: {
        command: "query",
        json: true,
        allWorkspaces: true,
        filter: {
          beadId: "b-1",
          beadExact: true,
          runId: "r-1",
          sessionId: "s-1",
          since: "2026-10-05T12:00:00Z",
          kinds: ["tool.called", "gate.ran"],
          limit: 5,
          afterId: 10,
        },
      },
    });
    const backup = parseAuditArgs(["--backup", "--json"]);
    expect(backup.ok && backup.value.command).toBe("backup");
    const compact = parseAuditArgs(["--compact"]);
    expect(compact.ok && compact.value.command).toBe("compact");
  });
});

describe("formatTable", () => {
  test("the table has one header and one line per event, with a dash for what an event lacks", () => {
    const { path } = sandbox();
    appendEvent(
      event("w", {
        sessionId: "sess-1",
        beadId: "b-1",
        runId: "r-1",
        executor: { provider: "claude", model: "model-1" },
      }),
      { path },
    );
    appendEvent(event("w"), { path });
    const lines = formatTable(queryEvents({}, { path })).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]?.trim().split(/\s+/)).toEqual([
      "id",
      "ts",
      "kind",
      "session",
      "bead",
      "run",
      "model",
    ]);
    expect(lines[1]?.trim().split(/\s+/).slice(2)).toEqual([
      "tool.called",
      "sess-1",
      "b-1",
      "r-1",
      "model-1",
    ]);
    expect(lines[2]?.trim().split(/\s+/).slice(2)).toEqual([
      "tool.called",
      "-",
      "-",
      "-",
      "-",
    ]);
    expect(formatTable([])).toBe("no events");
  });
});

describe("forge:audit (spawned)", () => {
  test("forge:audit --json prints the envelope and exits 0", async () => {
    const box = sandbox();
    const here = resolveCheckout(box.cwd).workspace;
    appendEvent(event(here, { runId: "r-1" }), { path: box.path });
    appendEvent(event(here, { runId: "r-2" }), { path: box.path });
    appendEvent(event("c:/another/checkout", { runId: "r-1" }), {
      path: box.path,
    });
    closeLedger();

    const scoped = await audit(box, ["--run", "r-1", "--json"]);
    expect(scoped.exitCode).toBe(0);
    const envelope = JSON.parse(scoped.stdout) as {
      ok: boolean;
      data: Array<{ id: number; runId: string; workspace: string }>;
      error: null;
    };
    expect(validateOperatorEnvelope(envelope).ok).toBe(true);
    expect(envelope.ok).toBe(true);
    expect(envelope.error).toBeNull();
    expect(envelope.data.map((row) => row.id)).toEqual([1]);
    expect(envelope.data[0]?.workspace).toBe(here);

    const everywhere = await audit(box, [
      "--run",
      "r-1",
      "--all-workspaces",
      "--json",
    ]);
    expect(everywhere.exitCode).toBe(0);
    const all = JSON.parse(everywhere.stdout) as {
      data: Array<{ id: number }>;
    };
    expect(all.data.map((row) => row.id)).toEqual([1, 3]);
  }, 30_000);

  test("on a ledger that does not exist yet, forge:audit --json answers with an empty list", async () => {
    const box = sandbox();
    const result = await audit(box, ["--kind", "tool.called", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      data: [],
      error: null,
    });
  }, 30_000);

  test("a bad filter prints the envelope with ok false and exits 2", async () => {
    const box = sandbox();
    for (const args of [
      ["--since", "yesterday", "--json"],
      ["--since", "yesterday"],
    ]) {
      const result = await audit(box, args);
      expect(result.exitCode).toBe(2);
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        data: null;
        error: string;
      };
      expect(validateOperatorEnvelope(envelope).ok).toBe(true);
      expect(envelope.ok).toBe(false);
      expect(envelope.data).toBeNull();
      expect(envelope.error).toContain("yesterday");
    }
  }, 30_000);

  test("forge:audit --backup --json writes a dated snapshot under the ledger home and reports its path", async () => {
    const box = sandbox();
    appendEvent(event("w"), { path: box.path });
    closeLedger();
    const result = await audit(box, ["--backup", "--json"]);
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { path: string; pruned: string[] };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.path).toMatch(
      /backups[\\/]ledger-\d{4}-\d{2}-\d{2}\.db$/,
    );
    expect(existsSync(envelope.data.path)).toBe(true);
    expect(envelope.data.path.startsWith(join(box.home, "backups"))).toBe(true);
  }, 30_000);
});
