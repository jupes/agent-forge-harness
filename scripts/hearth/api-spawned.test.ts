/**
 * The hearth as a process: `bun scripts/hearth/server.ts`, the way the
 * dashboard and the browser suite start it.
 *
 * `api.test.ts` drives `createHearth` in this process with everything
 * injected. Two things only a real process shows: that `main()` hands the
 * council service a ledger, and that the stream delivers an event appended by
 * a different process than the one serving it.
 */

import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LedgerEvent } from "../../types/hearth";
import { appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { latestEventId, queryEvents } from "../ledger/query";
import { resolveCheckout } from "../ledger/workspace";
import { lockPath } from "./home";
import { type HearthLock, readLock } from "./lock";
import { OPERATOR_HEADER } from "./paths";
import { openEventStream } from "./testing";

const REPO = resolve(import.meta.dir, "..", "..");

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

interface Spawned {
  url: string;
  token: string;
  ledger: string;
  workspace: string;
}

/** Start a hearth process on a temp home and root, and wait for its lock. */
async function spawnHearth(): Promise<Spawned> {
  const home = mkdtempSync(join(tmpdir(), "af-spawned-home-"));
  const root = mkdtempSync(join(tmpdir(), "af-spawned-root-"));
  // Its own workspace in the ledger, and the council profile `main()` looks for under the root.
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "councils"));
  copyFileSync(
    join(REPO, "councils", "default.json"),
    join(root, "councils", "default.json"),
  );
  const ledger = join(home, "ledger.db");

  const child: ChildProcess = spawn(
    "bun",
    [join(REPO, "scripts", "hearth", "server.ts"), "--root", root],
    {
      // The child gets a home of its own: nothing it writes reaches the real one.
      env: {
        ...process.env,
        AGENT_FORGE_HOME: home,
        COUNCIL_RUNS_DIR: join(root, "council-runs"),
        HEARTH_PORT: "",
      },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  cleanup.push(async () => {
    child.kill();
    await new Promise<void>((done) => {
      if (child.exitCode !== null) done();
      else child.once("exit", () => done());
    });
    closeLedger(ledger);
    for (const dir of [home, root]) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // A file the dead process still holds on Windows: the OS temp directory reclaims it.
      }
    }
  });

  let lock: HearthLock | null = null;
  for (let i = 0; i < 300 && lock === null; i++) {
    await new Promise((done) => setTimeout(done, 100));
    lock = readLock(lockPath(home, root));
  }
  if (lock === null) throw new Error("the hearth did not publish its lock");
  // The token is published after the lock; wait for the file the lock names.
  let token = "";
  for (let i = 0; i < 100 && token === ""; i++) {
    try {
      token = readFileSync(lock.tokenFile, "utf8").trim();
    } catch {
      await new Promise((done) => setTimeout(done, 50));
    }
  }
  if (token === "") throw new Error("the hearth did not publish its token");
  return {
    url: `http://127.0.0.1:${lock.port}`,
    token,
    ledger,
    workspace: resolveCheckout(root).workspace,
  };
}

test("a hearth process records the council events of a run started over HTTP, after its audit row", async () => {
  const hearth = await spawnHearth();
  const started = await fetch(`${hearth.url}/__agent-forge/council/runs`, {
    method: "POST",
    headers: {
      Origin: hearth.url,
      "Content-Type": "application/json",
      [OPERATOR_HEADER]: hearth.token,
    },
    body: JSON.stringify({
      sourceType: "text",
      source: "Evaluate this plan and record any missing evidence.",
      runId: "spawned-run",
      beadId: "demo-7",
    }),
  });
  expect(started.status).toBe(202);

  // Read from this process: the events were written by the other one.
  const recorded = (): LedgerEvent[] =>
    queryEvents({ workspace: hearth.workspace }, { path: hearth.ledger });
  for (
    let i = 0;
    i < 400 &&
    !recorded().some((event) => event.kind === "council.run.finished");
    i++
  )
    await new Promise((done) => setTimeout(done, 50));

  const events = recorded();
  expect(events.map((event) => event.kind)).toEqual([
    "operator.action",
    "council.run.started",
    "council.run.finished",
  ]);
  expect(events[0]?.payload).toEqual({
    action: "council.run.start",
    surface: "api",
    target: "spawned-run",
  });
  for (const event of events) {
    expect(event.beadId).toBe("demo-7");
    expect(event).not.toHaveProperty("sessionId");
    expect(event).not.toHaveProperty("executor");
  }

  const unauthorised = await fetch(`${hearth.url}/__agent-forge/council/runs`, {
    method: "POST",
    headers: { Origin: hearth.url, "Content-Type": "application/json" },
    body: JSON.stringify({ sourceType: "text", source: "No token." }),
  });
  expect(unauthorised.status).toBe(403);
  expect(recorded().length).toBe(3);
}, 60_000);

test("a hearth process streams an event appended by another process within 1 s, at the default interval", async () => {
  const hearth = await spawnHearth();
  const append = (gate: string): number => {
    const stored = appendEvent(
      {
        kind: "gate.ran",
        workspace: hearth.workspace,
        payload: { gate, passed: true },
      },
      { path: hearth.ledger },
    );
    if (!stored.ok || !("id" in stored)) throw new Error("event not stored");
    return stored.id;
  };
  const first = append("before-connect");
  expect(
    latestEventId({ workspace: hearth.workspace }, { path: hearth.ledger }),
  ).toBe(first);

  // Resuming at the newest id asks for deltas only: no snapshot is built, so
  // this test never makes the process run `bd`.
  const client = await openEventStream(`${hearth.url}/__agent-forge/stream`, {
    Origin: hearth.url,
    "Last-Event-ID": String(first),
  });
  cleanup.push(() => client.close());
  expect(client.response.status).toBe(200);
  expect(await client.quiet(300)).toBe(true);

  for (const gate of ["typecheck", "lint", "tests"]) {
    const id = append(gate);
    const appended = performance.now();
    const delta = await client.next(1000);
    const elapsed = performance.now() - appended;
    expect(delta).toMatchObject({ event: "delta", id: String(id) });
    expect(JSON.parse(delta?.data ?? "{}")).toMatchObject({
      id,
      kind: "gate.ran",
      payload: { gate, passed: true },
    });
    expect(elapsed).toBeLessThan(1000);
  }
}, 60_000);
