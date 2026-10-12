/**
 * The queue against a real `bd`, and the in-memory tracker beside it.
 *
 * Skipped unless `AGENT_FORGE_SCRATCH_TRACKER` names a directory that holds a
 * scratch tracker: its own git repository with no remote, initialised with
 * `bd init`, with no Dolt remote. It is run by hand; the hermetic suite never
 * reaches a tracker. It writes issues to the tracker it is given and to
 * nothing else.
 *
 *   mkdir scratch && cd scratch && git init && bd init --prefix probe --non-interactive
 *   AGENT_FORGE_SCRATCH_TRACKER=/path/to/scratch bun test scripts/scheduler/queue-bd.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { QueueAction, QueueActor } from "../../types/hearth";
import { type BdResult, bdRunner } from "../hearth/routes/dev-api";
import { QUEUE_LIST_ARGS, queueEntries } from "../hearth/routes/operator-reads";
import { parsed, refusal } from "../hearth/tracker-write";
import { appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { queryEvents } from "../ledger/query";
import {
  createQueue,
  pickable,
  QUEUED_EXACT_ARGS,
  queueStateOf,
} from "./queue";
import {
  answerQueueList,
  queueTracker,
  type TrackedBead,
} from "./queue-fixture";

const scratch = process.env["AGENT_FORGE_SCRATCH_TRACKER"] ?? "";
const REPO = resolve(import.meta.dir, "..", "..");

/** Why the directory is not a scratch tracker, or null when it is one. */
function notScratch(dir: string): string | null {
  if (!existsSync(join(dir, ".beads"))) return "it holds no .beads directory";
  const real = realpathSync.native(dir);
  const run = (command: string, args: string[]): string =>
    execFileSync(command, args, { cwd: dir, encoding: "utf8" }).trim();
  const top = realpathSync.native(run("git", ["rev-parse", "--show-toplevel"]));
  if (top !== real) return "it is not the top of its own git repository";
  if (
    real === REPO ||
    real.startsWith(REPO + sep) ||
    REPO.startsWith(real + sep)
  )
    return "it is this repository, or holds it";
  if (run("git", ["remote"]) !== "") return "its git repository has a remote";
  const remotes = run("bd", ["dolt", "remote", "list"]);
  return remotes.includes("No remotes configured")
    ? null
    : "its tracker has a Dolt remote";
}

const home = mkdtempSync(join(tmpdir(), "af-queue-bd-"));
const ledger = join(home, "ledger.db");

afterAll(() => {
  closeLedger(ledger);
  rmSync(home, { recursive: true, force: true, maxRetries: 3 });
});

describe.skipIf(scratch === "")("the queue and a real bd", () => {
  const bd = bdRunner(scratch);

  beforeAll(() => {
    const why = notScratch(scratch);
    if (why !== null)
      throw new Error(
        `AGENT_FORGE_SCRATCH_TRACKER is not a scratch tracker: ${why}`,
      );
  });

  async function create(title: string, parent?: string): Promise<string> {
    const result = await bd([
      "create",
      `--title=${title}`,
      "--type=task",
      "--priority=3",
      ...(parent !== undefined ? [`--parent=${parent}`] : []),
      "--json",
    ]);
    const issue = parsed(result.stdout);
    if (
      typeof issue !== "object" ||
      issue === null ||
      typeof (issue as { id?: unknown }).id !== "string"
    )
      throw new Error(`bd create printed no issue: ${result.stderr}`);
    return (issue as { id: string }).id;
  }

  /** What the queue reads out of an answer: the status, and the one issue's id, labels and metadata. */
  function read(result: BdResult): unknown {
    const issues = parsed(result.stdout);
    const issue =
      Array.isArray(issues) && issues.length === 1
        ? (issues[0] as Record<string, unknown>)
        : null;
    return {
      status: result.status,
      issue:
        issue === null
          ? null
          : {
              id: issue["id"],
              hasLabels: "labels" in issue,
              labels: issue["labels"] ?? [],
              hasMetadata: "metadata" in issue,
              metadata: issue["metadata"] ?? {},
              standing: queueStateOf(issue),
            },
    };
  }

  test("each argument shape the queue sends is answered alike by bd and by the in-memory tracker", async () => {
    const id = await create("queue contract: shapes");
    const tracker = queueTracker([{ id }]);
    const show = ["show", "--readonly", "--json", "--", id];
    const update = (...changes: string[]): string[] => [
      "update",
      ...changes,
      "--json",
      "--",
      id,
    ];
    const shapes: Array<[string, string[]]> = [
      ["show of a bead with no labels and no metadata", show],
      [
        "the first label, with its metadata",
        update(
          "--add-label=queue:proposed",
          "--set-metadata=queue_state=proposed",
        ),
      ],
      ["show after it", show],
      [
        "a label swap",
        update(
          "--remove-label=queue:proposed",
          "--add-label=queue:approved",
          "--set-metadata=queue_state=approved",
        ),
      ],
      [
        "a pause, with where from",
        update(
          "--remove-label=queue:approved",
          "--add-label=queue:paused",
          "--set-metadata=queue_state=paused",
          "--set-metadata=queue_resume=approved",
        ),
      ],
      ["show of a paused bead", show],
      [
        "a resume, with the unset",
        update(
          "--remove-label=queue:paused",
          "--add-label=queue:approved",
          "--set-metadata=queue_state=approved",
          "--unset-metadata=queue_resume",
        ),
      ],
      [
        "a remove of a label that is not there: silent, and the add happens",
        update("--remove-label=queue:queued", "--add-label=queue:running"),
      ],
      [
        "the same label added and removed: none is left",
        update("--remove-label=queue:running", "--add-label=queue:running"),
      ],
      ["a smith", update("--set-metadata=smith=claude-master")],
      ["show at the end", show],
    ];
    for (const [title, args] of shapes) {
      const real = await bd(args);
      const fake = await tracker.run(args);
      expect({ title, ...(read(fake) as object) }).toEqual({
        title,
        ...(read(real) as object),
      });
    }

    // An id no issue has: both exit 1 and both say so in the words the queue looks for.
    for (const args of [
      ["show", "--readonly", "--json", "--", "probe-no-such-bead"],
      [
        "update",
        "--add-label=queue:proposed",
        "--json",
        "--",
        "probe-no-such-bead",
      ],
    ]) {
      const real = await bd(args);
      const fake = await tracker.run(args);
      expect({ args, status: fake.status }).toEqual({
        args,
        status: real.status,
      });
      expect(real.status).toBe(1);
      expect(refusal(real)).toMatch(/no issues? found/i);
      expect(refusal(fake)).toMatch(/no issues? found/i);
    }
  }, 120_000);

  test("a child gets its parent's queue label and none of its metadata; the parent's metadata is printed under dependencies only", async () => {
    const parent = await create("queue contract: parent");
    await bd([
      "update",
      "--add-label=queue:queued",
      "--set-metadata=queue_state=queued",
      "--json",
      "--",
      parent,
    ]);
    const child = await create("queue contract: child", parent);
    const shown = await bd(["show", "--readonly", "--json", "--", child]);
    const issue = (parsed(shown.stdout) as Array<Record<string, unknown>>)[0];
    expect(issue?.["labels"]).toEqual(["queue:queued"]);
    expect(issue?.["metadata"]).toBeUndefined();
    expect(JSON.stringify(issue?.["dependencies"])).toContain("queue_state");
    expect(queueStateOf(issue ?? {})).toEqual({
      kind: "unbacked",
      label: "queued",
    });
    // The fixture's child, built the way the tests build one, reads the same.
    const fixture: TrackedBead = {
      id: child,
      labels: ["queue:queued"],
      parent: { id: parent, metadata: { queue_state: "queued" } },
    };
    const fake = await queueTracker([fixture]).run([
      "show",
      "--readonly",
      "--json",
      "--",
      child,
    ]);
    expect((read(fake) as { issue: unknown }).issue).toEqual(
      (read(shown) as { issue: unknown }).issue,
    );
  }, 120_000);

  test("the lists the hearth and eligibility send, and a show of several ids, are answered alike by bd and by the in-memory tracker", async () => {
    const files = "## Files\nsrc/**\n";
    const a = await create("queue contract: list a");
    const b = await create("queue contract: list b");
    const c = await create("queue contract: list c");
    await bd([
      "update",
      `--description=${files}`,
      "--add-label=queue:queued",
      "--set-metadata=queue_state=queued",
      "--json",
      "--",
      a,
    ]);
    await bd([
      "update",
      "--add-label=queue:queued",
      "--set-metadata=queue_state=queued",
      "--json",
      "--",
      b,
    ]);
    // b waits on a.
    await bd(["dep", "add", b, a]);
    await bd([
      "update",
      "--add-label=queue:approved",
      "--set-metadata=queue_state=approved",
      "--json",
      "--",
      c,
    ]);
    const mine = new Set([a, b, c]);
    const beads: TrackedBead[] = [
      {
        id: a,
        labels: ["queue:queued"],
        metadata: { queue_state: "queued" },
        description: files,
        priority: 3,
      },
      {
        id: b,
        labels: ["queue:queued"],
        metadata: { queue_state: "queued" },
        priority: 3,
        blockedBy: [a],
      },
      {
        id: c,
        labels: ["queue:approved"],
        metadata: { queue_state: "approved" },
        priority: 3,
      },
    ];
    /** What a reader takes from a list row: id, labels, metadata, description, and blocking edges. */
    const rows = (result: BdResult | undefined) =>
      ((parsed(result?.stdout ?? "") as Array<Record<string, unknown>>) ?? [])
        .filter((row) => mine.has(row["id"] as string))
        .map((row) => ({
          id: row["id"],
          labels: row["labels"] ?? [],
          metadata: row["metadata"] ?? {},
          description: row["description"] ?? "",
          priority: row["priority"],
          blocks: (
            (row["dependencies"] as
              | Array<Record<string, unknown>>
              | undefined) ?? []
          )
            .filter((d) => d["type"] === "blocks")
            .map((d) => [d["issue_id"], d["depends_on_id"]]),
        }))
        .sort((x, y) => String(x.id).localeCompare(String(y.id)));
    for (const args of [
      [...QUEUE_LIST_ARGS],
      [...QUEUED_EXACT_ARGS],
      [...QUEUED_EXACT_ARGS, "--ready"],
    ]) {
      const real = await bd(args);
      expect({ args, rows: rows(answerQueueList(args, beads)) }).toEqual({
        args,
        rows: rows(real),
      });
    }

    const tracker = queueTracker(beads);
    for (const ids of [
      [a, "probe-no-such-bead", c],
      ["probe-no-such-bead", "probe-nor-this"],
    ]) {
      const args = ["show", "--readonly", "--json", "--", ...ids];
      const real = await bd(args);
      const fake = await tracker.run(args);
      const shown = (result: BdResult) => {
        const answer = parsed(result.stdout);
        return Array.isArray(answer)
          ? answer.map((row) => (row as { id: string }).id).sort()
          : (answer as { error?: string } | undefined)?.error;
      };
      expect({ ids, status: fake.status, shown: shown(fake) }).toEqual({
        ids,
        status: real.status,
        shown: shown(real),
      });
    }
  }, 120_000);

  test("the whole machine on a real bd, and what bd lists as queued", async () => {
    const queue = createQueue({
      workspace: scratch,
      runBd: bd,
      appendEvent: (event) => appendEvent(event, { path: ledger }),
      lockFile: join(home, "queue-lock.db"),
    });
    const walk = async (
      id: string,
      steps: Array<[QueueAction, QueueActor]>,
    ): Promise<void> => {
      for (const [action, by] of steps) {
        const result = await queue.move(id, action, by);
        expect({
          id,
          action,
          ok: result.ok,
          why: result.ok ? "" : result.error,
        }).toEqual({ id, action, ok: true, why: "" });
      }
    };
    const toQueued: Array<[QueueAction, QueueActor]> = [
      ["propose", "scheduler"],
      ["approve", "operator"],
      ["queue", "operator"],
    ];

    // One bead through every move of the happy path, with a pause on the way.
    const walked = await create("queue contract: walked");
    await walk(walked, [
      ...toQueued,
      ["pause", "operator"],
      ["resume", "operator"],
      ["start", "scheduler"],
      ["submit", "scheduler"],
      ["complete", "operator"],
    ]);
    expect(
      queryEvents(
        { workspace: scratch, beadId: walked, beadExact: true },
        { path: ledger },
      ).map((event) => event.payload),
    ).toEqual([
      { from: null, to: "proposed", reason: "propose:scheduler" },
      { from: "proposed", to: "approved", reason: "approve:operator" },
      { from: "approved", to: "queued", reason: "queue:operator" },
      { from: "queued", to: "paused", reason: "pause:operator" },
      { from: "paused", to: "queued", reason: "resume:operator" },
      { from: "queued", to: "running", reason: "start:scheduler" },
      { from: "running", to: "review", reason: "submit:scheduler" },
      { from: "review", to: "done", reason: "complete:operator" },
    ]);
    // An illegal move on the real bead: refused, and bd was asked to change nothing.
    const again = await queue.move(walked, "start", "scheduler");
    expect(again.ok ? "ok" : again.kind).toBe("refused");

    // The four kinds of bead that carry queue:queued.
    const backed = await create("queue contract: queued by the queue");
    await walk(backed, toQueued);
    const inherited = await create("queue contract: inherited", backed);
    const twoLabels = await create("queue contract: two labels");
    await walk(twoLabels, toQueued);
    await bd(["update", "--add-label=queue:paused", "--json", "--", twoLabels]);
    const closed = await create("queue contract: closed");
    await walk(closed, toQueued);
    await bd(["close", "--reason=queue contract", "--json", "--", closed]);
    // And an inherited queue:proposed, proposed: the label stays (bd adds before it removes).
    const proposedParent = await create("queue contract: proposed parent");
    await walk(proposedParent, [["propose", "operator"]]);
    const proposedChild = await create(
      "queue contract: proposed child",
      proposedParent,
    );
    await walk(proposedChild, [["propose", "operator"]]);
    const after = await bd([
      "show",
      "--readonly",
      "--json",
      "--",
      proposedChild,
    ]);
    expect(
      (read(after) as { issue: { standing: unknown } }).issue.standing,
    ).toEqual({
      kind: "state",
      state: "proposed",
    });

    const ids = (result: BdResult): string[] =>
      (parsed(result.stdout) as Array<{ id: string }>).map((issue) => issue.id);
    const mine = (listed: string[]): string[] =>
      listed
        .filter((id) => [backed, inherited, twoLabels, closed].includes(id))
        .sort();

    // The literal command of the acceptance criterion: the queued bead, and the two the queue did not make.
    const literal = await bd([
      "list",
      "--label",
      "queue:queued",
      "--json",
      "--limit",
      "0",
    ]);
    expect(mine(ids(literal))).toEqual([backed, inherited, twoLabels].sort());
    // The exact command: only the bead the queue queued.
    const exact = await bd([...QUEUED_EXACT_ARGS]);
    expect(mine(ids(exact))).toEqual([backed]);
    // The read behind GET /queue, and pickable over it: the same one bead.
    const { QUEUE_LIST_ARGS } = await import("../hearth/routes/operator-reads");
    const all = queueEntries((await bd([...QUEUE_LIST_ARGS])).stdout);
    if (!all.ok) throw new Error(all.error);
    expect(mine(pickable(all.entries).map((entry) => entry.beadId))).toEqual([
      backed,
    ]);
    // The scheduler cannot start either of the two extra beads the literal command lists.
    for (const id of [inherited, twoLabels]) {
      const started = await queue.move(id, "start", "scheduler");
      expect({ id, kind: started.ok ? "ok" : started.kind }).toEqual({
        id,
        kind: "refused",
      });
    }
    expect((await queue.move(backed, "start", "scheduler")).ok).toBe(true);
  }, 240_000);
});
