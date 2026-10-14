import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type {
  LedgerEventInput,
  OperatorEnvelope,
  Scoreboard,
} from "../../../types/hearth";
import { appendEvent } from "../../ledger/append";
import {
  ELSEWHERE_EVENTS,
  ELSEWHERE_WORKSPACE,
  SCOREBOARD_EVENTS,
} from "../../ledger/scoreboard-fixture";
import { startTestHearth, type TestHearth } from "../testing";

/**
 * `GET /scoreboard` against `forge:audit --scoreboard`: the hearth's answer
 * and the CLI's, run as a child process from the hearth's checkout with the
 * hearth's ledger home, over one fixture ledger with two smiths.
 */

const open: TestHearth[] = [];
afterEach(async () => {
  for (const hearth of open.splice(0)) await hearth.close();
});

/** A hearth whose ledger holds the fixture, and one event from another checkout. */
async function seeded(): Promise<TestHearth> {
  const h = await startTestHearth();
  open.push(h);
  for (const event of SCOREBOARD_EVENTS) h.append(event);
  for (const event of ELSEWHERE_EVENTS) {
    // justification: the fixture keeps each kind with its payload; only the workspace is added.
    const input = {
      ...event,
      workspace: ELSEWHERE_WORKSPACE,
    } as LedgerEventInput;
    if (!appendEvent(input, { path: h.ledger }).ok)
      throw new Error("the other checkout's event was not stored");
  }
  return h;
}

async function route(
  h: TestHearth,
  query = "",
): Promise<{ status: number; body: OperatorEnvelope<Scoreboard> }> {
  const response = await fetch(`${h.api}/scoreboard${query}`, {
    headers: h.headers(),
  });
  return {
    status: response.status,
    // justification: the envelope's data is the route's own type; the test reads it as such.
    body: (await response.json()) as OperatorEnvelope<Scoreboard>,
  };
}

const CLI = join(import.meta.dir, "..", "..", "ledger", "audit-cli.ts");

/** This environment minus anything that names a live session or ledger, with the hearth's home. */
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

/** `forge:audit --scoreboard --json`, run from the hearth's checkout. */
async function cli(
  h: TestHearth,
  args: string[] = [],
): Promise<OperatorEnvelope<Scoreboard>> {
  const child = Bun.spawn(
    [process.execPath, CLI, "--scoreboard", "--json", ...args],
    {
      cwd: h.root,
      env: childEnv(h.home),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  // justification: the CLI prints the operator envelope; the test reads its data as the scoreboard.
  return JSON.parse(stdout) as OperatorEnvelope<Scoreboard>;
}

describe("GET /scoreboard", () => {
  test("answers the same scoreboard as forge:audit --scoreboard run from the hearth's checkout, over a ledger with two smiths", async () => {
    const h = await seeded();
    const answer = await route(h);
    expect(answer.status).toBe(200);
    expect(answer.body.ok).toBe(true);
    const printed = await cli(h);
    expect(printed.ok).toBe(true);
    expect(answer.body.data).toEqual(printed.data);

    // Not an empty agreement: both smiths are there, and only this checkout's events.
    const board = answer.body.data;
    expect(board?.rows.map((row) => row.executor?.smith ?? null)).toEqual([
      "claude-journeyman",
      "codex-journeyman",
      null,
      null,
    ]);
    expect(board?.events).toBe(SCOREBOARD_EVENTS.length - 1);
    expect(board?.rows[0]?.gates).toEqual({
      ran: 3,
      passed: 2,
      failed: 1,
      passRate: 2 / 3,
    });
  }, 30_000);

  test("since narrows it as forge:audit --since does", async () => {
    const h = await seeded();
    const since = "2026-10-10T09:00:00Z";
    const answer = await route(h, `?since=${encodeURIComponent(since)}`);
    expect(answer.status).toBe(200);
    expect(answer.body.data).toEqual((await cli(h, ["--since", since])).data);
    expect(answer.body.data?.from).toBe("2026-10-10T09:00:00.000Z");
    expect(answer.body.data?.events).toBeLessThan(SCOREBOARD_EVENTS.length - 1);
  }, 30_000);

  test("refuses another parameter, a repeated one and a since that is not ISO 8601 with 400, and appends nothing", async () => {
    const h = await seeded();
    const before = h.events().length;
    for (const query of [
      "?bead=b-1",
      "?all=1",
      "?since=yesterday",
      "?since=2026-10-01T00:00:00Z&since=2026-10-02T00:00:00Z",
    ]) {
      const answer = await route(h, query);
      expect({ query, status: answer.status, ok: answer.body.ok }).toEqual({
        query,
        status: 400,
        ok: false,
      });
    }
    expect(h.events().length).toBe(before);
  });

  test("is a read row and not a stream collection", async () => {
    const h = await seeded();
    const row = h.hearth.routes.find(
      (candidate) =>
        candidate.method === "GET" && candidate.path === "/scoreboard",
    );
    expect(row?.kind).toBe("read");
    expect(
      row?.kind === "read" ? row.collection : "not a read",
    ).toBeUndefined();
  });
});
