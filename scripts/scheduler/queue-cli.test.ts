import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BdResult, BdRunner } from "../hearth/routes/dev-api";
import { closeLedger } from "../ledger/db";
import { resolveCheckout } from "../ledger/workspace";
import { runQueueCli } from "./queue-cli";
import { answerQueueList, type TrackedBead } from "./queue-fixture";
import type { CliDeps } from "./reservations-cli";

const home = mkdtempSync(join(tmpdir(), "af-xsqx-queue-cli-"));
afterAll(() => {
  closeLedger(join(home, "ledger.db"));
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

let n = 0;
function deps(runBd: BdRunner): CliDeps {
  const root = join(home, `checkout-${++n}`);
  mkdirSync(join(root, ".git"), { recursive: true });
  return {
    root,
    workspace: resolveCheckout(root).workspace,
    runBd,
    ledgerPath: join(home, "ledger.db"),
    lockFile: join(home, "queue-lock.db"),
  };
}

/** A tracker that answers only the queue's list, and records every call. */
function listing(beads: TrackedBead[], calls: string[][]): BdRunner {
  return (args) => {
    calls.push(args);
    return (
      answerQueueList(args, beads) ?? {
        status: 1,
        stdout: "",
        stderr: "not asked",
      }
    );
  };
}

describe("forge:queue", () => {
  test("reconcile prints the report in the envelope and exits 0: a state the queue wrote with no recorded move is a gap", async () => {
    const id = "agent-forge-harness-q1";
    const calls: string[][] = [];
    const { exit, out } = await runQueueCli(
      ["reconcile"],
      deps(
        listing(
          [
            {
              id,
              labels: ["queue:queued"],
              metadata: { queue_state: "queued" },
            },
          ],
          calls,
        ),
      ),
    );
    expect({ exit, ok: out.ok, error: out.error }).toEqual({
      exit: 0,
      ok: true,
      error: null,
    });
    expect(out.data).toEqual({
      beads: 1,
      moves: 0,
      drift: [
        {
          kind: "gap",
          beadId: id,
          recorded: null,
          found: "queued",
          labels: ["queue:queued"],
        },
      ],
    });
    expect(calls.map((args) => args[0])).toEqual(["list"]);
  });

  test("a queue that cannot be read exits 1 with the error, and no report", async () => {
    const failing: BdRunner = (): BdResult => ({
      status: 1,
      stdout: "",
      stderr: "Error: no beads database found\n",
    });
    const { exit, out } = await runQueueCli(["reconcile"], deps(failing));
    expect({ exit, out }).toEqual({
      exit: 1,
      out: {
        ok: false,
        data: null,
        error: "bd list failed: no beads database found",
      },
    });
  });

  test("no command, an unknown one, or an argument after reconcile is a usage error, and bd is not called", async () => {
    for (const argv of [[], ["move"], ["reconcile", "--fix"]]) {
      const calls: string[][] = [];
      const { exit, out } = await runQueueCli(argv, deps(listing([], calls)));
      expect(exit).toBe(1);
      expect(out.ok).toBe(false);
      expect(out.error).toContain("Usage: reconcile");
      expect(calls).toEqual([]);
    }
  });

  test("package.json runs it as forge:queue, and as a process a usage error prints the envelope and exits 1", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(manifest.scripts["forge:queue"]).toBe(
      "bun run scripts/scheduler/queue-cli.ts",
    );
    const result = spawnSync(
      "bun",
      [resolve(import.meta.dir, "queue-cli.ts")],
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
