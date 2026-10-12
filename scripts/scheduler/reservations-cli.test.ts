import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BdResult, BdRunner } from "../hearth/routes/dev-api";
import { closeLedger } from "../ledger/db";
import { resolveCheckout } from "../ledger/workspace";
import type { QueuedBead } from "./eligibility";
import { type CliDeps, cliDeps, runCli } from "./reservations-cli";

const home = mkdtempSync(join(tmpdir(), "af-res-cli-"));
afterAll(() => {
  closeLedger(join(home, "ledger.db"));
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

const files = (...globs: string[]) => `## Files\n${globs.join("\n")}\n`;
const ok = (value: unknown): BdResult => ({
  status: 0,
  stdout: JSON.stringify(value),
  stderr: "",
});

/** A tracker of queued beads, all ready, answering the reader's and reserve's calls. */
function tracker(beads: QueuedBead[]): BdRunner {
  return (args) => {
    if (args[0] === "list") return ok(beads);
    if (args[0] === "show") {
      const asked = args.slice(args.indexOf("--") + 1);
      return ok(beads.filter((b) => asked.includes(b.id)));
    }
    return { status: 1, stdout: "", stderr: "not asked" };
  };
}

let n = 0;
function deps(beads: QueuedBead[]): CliDeps {
  const root = join(home, `checkout-${++n}`);
  mkdirSync(join(root, ".git"), { recursive: true });
  return {
    root,
    workspace: resolveCheckout(root).workspace,
    runBd: tracker(beads),
    ledgerPath: join(home, "ledger.db"),
    lockFile: join(home, "queue-lock.db"),
  };
}

const bead = (id: string, globs: string[]): QueuedBead => ({
  id,
  title: id,
  issue_type: "task",
  status: "open",
  priority: 2,
  description: files(...globs),
});

/** What the commands under test answer, by field; each test reads the ones its command has. */
interface Answered {
  eligible: Array<{ id: string }>;
  waiting: Array<{ id: string; why: string; waitsOn?: string }>;
  reservation: { globs: string[] };
  reservations: Array<{ beadId: string }>;
  stale: unknown[];
}

async function run(argv: string[], d: CliDeps) {
  const { exit, out } = await runCli(argv, d);
  return {
    exit,
    out: { ok: out.ok, error: out.error, data: out.data as Answered },
  };
}

describe("forge:eligible and forge:reservations", () => {
  test("reserve, eligible, release: the overlapping bead waits while the first holds its files, then may start", async () => {
    const A = "agent-forge-harness-a1";
    const B = "agent-forge-harness-b2";
    const d = deps([bead(A, ["src/**"]), bead(B, ["src/a.ts"])]);

    const before = await run(["eligible"], d);
    expect(before.exit).toBe(0);
    expect(before.out.data.eligible.map((e: { id: string }) => e.id)).toEqual([
      A,
    ]);
    expect(before.out.data.waiting[0]).toMatchObject({ id: B, waitsOn: A });

    const reserved = await run(["reserve", A, join(d.root, "trees", "a")], d);
    expect(reserved).toMatchObject({ exit: 0, out: { ok: true } });
    expect(reserved.out.data.reservation.globs).toEqual(["src/**"]);

    const listed = await run(["list"], d);
    expect(
      listed.out.data.reservations.map((r: { beadId: string }) => r.beadId),
    ).toEqual([A]);
    expect(listed.out.data.stale).toEqual([]);

    // B overlaps A's reservation: it waits on A whatever the order.
    const during = await run(["eligible"], d);
    expect(
      during.out.data.waiting.find((w: { id: string }) => w.id === B),
    ).toMatchObject({
      waitsOn: A,
    });

    const released = await run(["release", A, join(d.root, "trees", "a")], d);
    expect(released).toMatchObject({ exit: 0, out: { ok: true } });
    expect((await run(["list"], d)).out.data.reservations).toEqual([]);
  });

  test("a busy host keeps everything waiting, with the reason given", async () => {
    const d = deps([bead("agent-forge-harness-a1", ["src/**"])]);
    const busy = await run(["eligible", "--busy", "load test"], d);
    expect(busy.out.data.eligible).toEqual([]);
    expect(busy.out.data.waiting[0]?.why).toContain("load test");
  });

  test("a refused reserve or release exits 1 with the reason; usage errors exit 1", async () => {
    const d = deps([bead("agent-forge-harness-a1", ["src/**"])]);
    expect(
      (await run(["release", "agent-forge-harness-a1", "x"], d)).exit,
    ).toBe(1);
    expect(
      (await run(["reserve", "agent-forge-harness-nope", "x"], d)).exit,
    ).toBe(1);
    for (const argv of [
      [],
      ["what"],
      ["reserve"],
      ["release", "a"],
      ["eligible", "--busy"],
    ])
      expect({ argv, exit: (await run(argv, d)).exit }).toEqual({
        argv,
        exit: 1,
      });
  });

  test("bd runs in the main checkout of a linked worktree; the ledger and lock are the harness home's", () => {
    const main = join(home, "main");
    const linked = join(main, "trees", "wt");
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    mkdirSync(linked, { recursive: true });
    writeFileSync(
      join(linked, ".git"),
      `gitdir: ${main.replaceAll("\\", "/")}/.git/worktrees/wt\n`,
    );
    const made = cliDeps(linked, {
      AGENT_FORGE_HOME: join(home, "forge-home"),
    });
    expect(made.bdRoot).toBe(main);
    expect(made.ledgerPath).toBe(join(home, "forge-home", "ledger.db"));
    expect(made.lockFile).toBe(join(home, "forge-home", "queue-lock.db"));
  });

  test("as a process, a usage error prints the envelope and exits 1, touching no tracker", () => {
    const result = spawnSync(
      "bun",
      [resolve(import.meta.dir, "reservations-cli.ts")],
      {
        cwd: home,
        encoding: "utf8",
        env: { ...process.env, AGENT_FORGE_HOME: join(home, "spawned-home") },
      },
    );
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  });
});
