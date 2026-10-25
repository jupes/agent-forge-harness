import { afterEach, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { join } from "node:path";
import type {
  LedgerEvent,
  OperatorEnvelope,
  QueueEntry,
  QueueMoveResult,
  QueueReassignResult,
  StreamSnapshot,
} from "../../../types/hearth";
import {
  answerQueueList,
  childOf,
  type QueueTracker,
  queueTracker,
  type TrackedBead,
} from "../../scheduler/queue-fixture";
import { bdAnswers, bdTime, readWrite } from "../bd-answers";
import { OPERATOR_HEADER } from "../paths";
import {
  openEventStream,
  startTestHearth,
  type TestHearth,
  type TestHearthOptions,
} from "../testing";
import { validateOperatorEnvelope } from "../validate";
import { OPERATOR_QUEUE_ACTIONS } from "./queue";

/**
 * The queue rows, through a hermetic hearth: a request goes in over HTTP, and
 * what is checked is the answer, the argument arrays `bd` was given and what
 * the ledger holds. `bd` is the in-memory tracker of the queue's own tests,
 * plugged into the hearth's stand-in; nothing reaches a tracker. The state
 * machine itself is walked in `scripts/scheduler/queue.test.ts`: this file is
 * about the way in.
 */

const open: TestHearth[] = [];

test("a conflicting external writer after the successful update answers unknown and records no false transition", async () => {
  const { h, tracker } = await start([backed("demo-1", "proposed")]);
  tracker.beforeUpdate = (bead) => {
    bead.labels = ["queue:halted"];
  };
  const answer = await post(h, "/queue/demo-1/approve");
  expect(answer.status).toBe(504);
  expect(tracker.calls.filter((args) => args[0] === "update")).toHaveLength(1);
  expect(queueLabels(tracker, "demo-1").sort()).toEqual([
    "queue:approved",
    "queue:halted",
  ]);
  expect(recorded(h).map((event) => event.kind)).toEqual(["operator.action"]);
});
afterEach(async () => {
  for (const hearth of open.splice(0)) await hearth.close();
});

const backed = (
  id: string,
  state: string,
  more: Record<string, unknown> = {},
): TrackedBead => ({
  id,
  labels: [`queue:${state}`],
  metadata: { queue_state: state, ...more },
});

async function start(
  beads: TrackedBead[],
  options: TestHearthOptions = {},
): Promise<{ h: TestHearth; tracker: QueueTracker }> {
  const h = await startTestHearth(options);
  open.push(h);
  const tracker = queueTracker(beads);
  h.bd.answer = (args) => tracker.answer(args);
  return { h, tracker };
}

interface Answer<T> {
  status: number;
  body: OperatorEnvelope<T>;
}

async function post<T = QueueMoveResult>(
  h: TestHearth,
  path: string,
  body: unknown = {},
  headers: Record<string, string> = h.headers(h.hearth.token),
): Promise<Answer<T>> {
  const response = await fetch(`${h.api}${path}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const parsed: unknown = await response.json();
  const checked = validateOperatorEnvelope(parsed);
  if (!checked.ok) throw new Error(`not an envelope: ${checked.error}`);
  // justification: the guard above proved the envelope; `T` is the caller's claim about `data`.
  return {
    status: response.status,
    body: checked.value as OperatorEnvelope<T>,
  };
}

/** What the ledger holds, reduced to what these tests compare. */
function recorded(
  h: TestHearth,
): Array<Pick<LedgerEvent, "kind" | "beadId" | "payload">> {
  return h.events().map((event) => ({
    kind: event.kind,
    ...(event.beadId !== undefined ? { beadId: event.beadId } : {}),
    payload: event.payload,
  })) as Array<Pick<LedgerEvent, "kind" | "beadId" | "payload">>;
}

const queueLabels = (tracker: QueueTracker, id: string): string[] =>
  (tracker.beads.get(id)?.labels ?? []).filter((label) =>
    label.startsWith("queue:"),
  );

describe("the queue rows", () => {
  test("the operator API offers propose, approve, queue, pause, resume and reassign, and no other queue action", async () => {
    const { h } = await start([]);
    expect([...OPERATOR_QUEUE_ACTIONS]).toEqual([
      "propose",
      "approve",
      "queue",
      "pause",
      "resume",
    ]);
    expect(
      h.hearth.routes
        .filter((route) => route.path.startsWith("/queue/"))
        .map((route) => `${route.method} ${route.path}`),
    ).toEqual([
      ...OPERATOR_QUEUE_ACTIONS.map((action) => `POST /queue/:id/${action}`),
      "POST /queue/:id/reassign",
    ]);
  });

  test("a bead walked through the operator's moves: each is one read and one write, an audit row and then the transition", async () => {
    const { h, tracker } = await start([backed("demo-1", "proposed")]);
    const steps: Array<[string, string | null, string]> = [
      ["approve", "proposed", "approved"],
      ["queue", "approved", "queued"],
      ["pause", "queued", "paused"],
      ["resume", "paused", "queued"],
    ];
    for (const [action, from, to] of steps) {
      const answer = await post(h, `/queue/demo-1/${action}`);
      expect({ action, status: answer.status, body: answer.body }).toEqual({
        action,
        status: 200,
        body: {
          ok: true,
          data: { id: "demo-1", action, from, to, recorded: true },
          error: null,
        },
      } as never);
      expect(queueLabels(tracker, "demo-1")).toEqual([`queue:${to}`]);
    }
    expect(recorded(h)).toEqual(
      steps.flatMap(([action, from, to]) => [
        {
          kind: "operator.action",
          beadId: "demo-1",
          payload: {
            action: `queue.${action}`,
            surface: "api",
            target: "demo-1",
          },
        },
        {
          kind: "bead.transitioned",
          beadId: "demo-1",
          payload: { from, to, reason: `${action}:operator` },
        },
      ]) as never,
    );
    // Two bd calls a move, and the status of the bead is never written.
    expect(tracker.calls.length).toBe(8);
    expect(
      tracker.calls.flat().filter((arg) => /status|claim/.test(arg)),
    ).toEqual([]);
    expect(tracker.beads.get("demo-1")?.metadata).toEqual({
      queue_state: "queued",
    });
  });

  test("a move the table refuses is 409 with the state and the moves allowed; the attempt is audited and nothing else is written", async () => {
    const { h, tracker } = await start([backed("demo-1", "proposed")]);
    const answer = await post(h, "/queue/demo-1/queue");
    expect(answer.status).toBe(409);
    expect(answer.body.error).toBe(
      'demo-1 is queue:proposed: "queue" is not a move from there. From proposed: approve (operator), pause (operator).',
    );
    expect(tracker.updates()).toEqual([]);
    expect(recorded(h)).toEqual([
      {
        kind: "operator.action",
        beadId: "demo-1",
        payload: { action: "queue.queue", surface: "api", target: "demo-1" },
      },
    ] as never);
  });

  test("the operator cannot reach running through the API: no route starts work, resume goes where the bead was paused from, and a bead paused while running resumes to queued", async () => {
    const { h, tracker } = await start([
      backed("demo-1", "paused", { queue_resume: "proposed" }),
      backed("demo-2", "paused", { queue_resume: "running" }),
    ]);
    const resumed = await post(h, "/queue/demo-1/resume");
    expect(resumed.body.data?.to).toBe("proposed");
    const fromRunning = await post(h, "/queue/demo-2/resume");
    expect(fromRunning.status).toBe(200);
    expect(fromRunning.body.data).toEqual({
      id: "demo-2",
      action: "resume",
      from: "paused",
      to: "queued",
      recorded: true,
    });
    for (const action of ["start", "submit", "complete", "halt"]) {
      const response = await fetch(`${h.api}/queue/demo-1/${action}`, {
        method: "POST",
        headers: h.headers(h.hearth.token),
        body: "{}",
      });
      expect({ action, status: response.status }).toEqual({
        action,
        status: 404,
      });
    }
    expect(queueLabels(tracker, "demo-1")).toEqual(["queue:proposed"]);
    expect(queueLabels(tracker, "demo-2")).toEqual(["queue:queued"]);
    expect(tracker.beads.get("demo-2")?.metadata).toEqual({
      queue_state: "queued",
    });
  });

  test("each way a move can fail has its status: 404, 409, 502, 504, and never 403", async () => {
    const cases: Array<
      [string, TrackedBead[], (tracker: QueueTracker) => void, number, string]
    > = [
      ["no such bead", [], () => undefined, 404, "No bead has the id demo-1"],
      [
        "two queue labels",
        [
          {
            id: "demo-1",
            labels: ["queue:proposed", "queue:queued"],
            metadata: { queue_state: "proposed" },
          },
        ],
        () => undefined,
        409,
        "queue:proposed and queue:queued",
      ],
      [
        "a label the queue did not write",
        [{ id: "demo-1", labels: ["queue:proposed"] }],
        () => undefined,
        409,
        "the queue did not write it",
      ],
      [
        "bd refuses the write",
        [backed("demo-1", "proposed")],
        (tracker) => {
          tracker.intercept = (args) =>
            args[0] === "update"
              ? bdAnswers.refusedOnStderr("the tracker is read-only")
              : undefined;
        },
        502,
        "the tracker is read-only",
      ],
      [
        "the write is killed at its limit",
        [backed("demo-1", "proposed")],
        (tracker) => {
          tracker.intercept = (args) =>
            args[0] === "update" ? bdAnswers.notFinished(args) : undefined;
        },
        504,
        "bd show demo-1",
      ],
      [
        "a writer outside the queue got in between",
        [backed("demo-1", "proposed")],
        (tracker) => {
          tracker.beforeUpdate = (bead) => {
            bead.labels = ["queue:halted"];
          };
        },
        504,
        "queue:approved and queue:halted",
      ],
    ];
    for (const [label, beads, arrange, status, says] of cases) {
      const { h, tracker } = await start(beads);
      arrange(tracker);
      const answer = await post(h, "/queue/demo-1/approve");
      expect({ label, status: answer.status }).toEqual({ label, status });
      expect(answer.body.error ?? "").toContain(says);
      // What the runner said repeats every argument; it is never passed on.
      expect(answer.body.error ?? "").not.toContain("Command failed");
      // The attempt was audited; no transition was recorded.
      expect(recorded(h).map((event) => event.kind)).toEqual([
        "operator.action",
      ]);
    }
  });
});

describe("what a queue row refuses before anything is recorded", () => {
  test("ids that are not a bead's, in the path: 400, or no such route; nothing appended, bd not called", async () => {
    const { h, tracker } = await start([backed("demo-1", "proposed")]);
    const ids = [
      "-rf",
      "--help",
      "--add-label=queue:queued",
      "demo-1%20--help",
      "demo-1%2Cdemo-2",
      "demo-1%0A--json",
      "demo-1%00",
      "..%2Fdemo-1",
      "demo%2F1",
      "%20demo-1",
      `demo-${"x".repeat(200)}`,
      "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "%ZZ",
    ];
    for (const action of [...OPERATOR_QUEUE_ACTIONS, "reassign"])
      for (const id of ids) {
        const response = await fetch(`${h.api}/queue/${id}/${action}`, {
          method: "POST",
          headers: h.headers(h.hearth.token),
          body: action === "reassign" ? '{"smith":"claude-master"}' : "{}",
        });
        expect({ action, id, status: response.status }).toEqual({
          action,
          id,
          status: 400,
        });
      }
    // A dot segment never reaches a row: the client folds it into the path, which then names no route.
    const dots = await fetch(`${h.api}/queue/%2E%2E/approve`, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: "{}",
    });
    expect(dots.status).toBe(404);
    expect(h.events()).toEqual([]);
    expect(tracker.calls).toEqual([]);
    expect(h.bd.calls).toEqual([]);
  });

  test("a body that holds anything the row does not take, a query string, and a body that is not an object: 400", async () => {
    const { h, tracker } = await start([backed("demo-1", "proposed")]);
    const bodies: Array<[string, unknown]> = [
      ["/queue/demo-1/approve", { to: "running" }],
      ["/queue/demo-1/approve", { by: "scheduler" }],
      ["/queue/demo-1/approve", { smith: "claude-master" }],
      ["/queue/demo-1/approve", []],
      ["/queue/demo-1/approve", "null"],
      ["/queue/demo-1/approve", '"approve"'],
      ["/queue/demo-1/approve?force=1", {}],
      ["/queue/demo-1/resume", { to: "running" }],
      [
        "/queue/demo-1/pause",
        { reason: "a free text the ledger must not hold" },
      ],
      ["/queue/demo-1/reassign", {}],
      ["/queue/demo-1/reassign", { smith: "claude-master", to: "running" }],
      [
        "/queue/demo-1/reassign?smith=claude-master",
        { smith: "claude-master" },
      ],
    ];
    for (const [path, body] of bodies) {
      const answer = await post(h, path, body);
      expect({ path, body, status: answer.status }).toEqual({
        path,
        body,
        status: 400,
      });
    }
    expect(h.events()).toEqual([]);
    expect(tracker.calls).toEqual([]);
  });

  test("no token, a forged token, another origin, no declared origin: 403, nothing appended, bd not called", async () => {
    const { h, tracker } = await start([backed("demo-1", "proposed")]);
    const token = h.hearth.token;
    const origin = { Origin: h.hearth.url, "Content-Type": "application/json" };
    const headers: Array<[string, Record<string, string>]> = [
      ["no token", origin],
      ["an empty token", { ...origin, [OPERATOR_HEADER]: "" }],
      [
        "a forged token",
        { ...origin, [OPERATOR_HEADER]: "0".repeat(token.length) },
      ],
      [
        "the token with one character changed",
        {
          ...origin,
          [OPERATOR_HEADER]: `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`,
        },
      ],
      [
        "the token as a bearer value",
        { ...origin, [OPERATOR_HEADER]: `Bearer ${token}` },
      ],
      [
        "the token in Authorization",
        { ...origin, Authorization: `Bearer ${token}` },
      ],
      [
        "the token in a cookie",
        { ...origin, Cookie: `${OPERATOR_HEADER}=${token}` },
      ],
      [
        "the token from another site",
        {
          Origin: "https://evil.example",
          "Content-Type": "application/json",
          [OPERATOR_HEADER]: token,
        },
      ],
      [
        "the token from another loopback port",
        {
          Origin: "http://127.0.0.1:1",
          "Content-Type": "application/json",
          [OPERATOR_HEADER]: token,
        },
      ],
      [
        "the token with a null origin",
        {
          Origin: "null",
          "Content-Type": "application/json",
          [OPERATOR_HEADER]: token,
        },
      ],
      [
        "the token and no declared origin",
        {
          "Content-Type": "application/json",
          [OPERATOR_HEADER]: token,
        },
      ],
      [
        "the token and a cross-site fetch",
        {
          "Sec-Fetch-Site": "cross-site",
          "Content-Type": "application/json",
          [OPERATOR_HEADER]: token,
        },
      ],
    ];
    for (const action of [...OPERATOR_QUEUE_ACTIONS, "reassign"])
      for (const [label, sent] of headers) {
        const response = await fetch(`${h.api}/queue/demo-1/${action}`, {
          method: "POST",
          headers: sent,
          body: action === "reassign" ? '{"smith":"claude-master"}' : "{}",
        });
        expect({ action, label, status: response.status }).toEqual({
          action,
          label,
          status: 403,
        });
      }
    // The token in the query string is a parameter the row does not take, and no token.
    const inQuery = await fetch(
      `${h.api}/queue/demo-1/approve?token=${token}`,
      { method: "POST", headers: origin, body: "{}" },
    );
    expect(inQuery.status).toBe(403);
    expect(h.events()).toEqual([]);
    expect(tracker.calls).toEqual([]);
    expect(queueLabels(tracker, "demo-1")).toEqual(["queue:proposed"]);
  });

  test("a request that sends the token or the origin twice is refused", async () => {
    const { h, tracker } = await start([backed("demo-1", "proposed")]);
    const port = Number(new URL(h.hearth.url).port);
    const send = (lines: string[]): Promise<string> =>
      new Promise((done, failed) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write(
            [
              "POST /__agent-forge/queue/demo-1/approve HTTP/1.1",
              `Host: 127.0.0.1:${port}`,
              "Content-Type: application/json",
              "Content-Length: 2",
              "Connection: close",
              ...lines,
              "",
              "{}",
            ].join("\r\n"),
          );
        });
        let seen = "";
        socket.on("data", (chunk) => {
          seen += String(chunk);
        });
        socket.on("end", () => done(seen.split("\r\n")[0] ?? ""));
        socket.on("error", failed);
      });
    const token = h.hearth.token;
    expect(
      await send([
        `Origin: ${h.hearth.url}`,
        `${OPERATOR_HEADER}: ${"0".repeat(token.length)}`,
        `${OPERATOR_HEADER}: ${token}`,
      ]),
    ).toContain("403");
    expect(
      await send([
        "Origin: https://evil.example",
        `Origin: ${h.hearth.url}`,
        `${OPERATOR_HEADER}: ${token}`,
      ]),
    ).toContain("403");
    expect(h.events()).toEqual([]);
    expect(tracker.calls).toEqual([]);
  });

  test("a GET is not an action: 405, and nothing moves", async () => {
    const { h, tracker } = await start([backed("demo-1", "proposed")]);
    const response = await fetch(`${h.api}/queue/demo-1/approve`, {
      headers: h.headers(h.hearth.token),
    });
    expect(response.status).toBe(405);
    expect(tracker.calls).toEqual([]);
  });
});

describe("two requests at once", () => {
  test("the same approve twice: one 200, one 409 that read the new state, one transition", async () => {
    const { h, tracker } = await start([backed("demo-1", "proposed")]);
    const answers = await Promise.all([
      post(h, "/queue/demo-1/approve"),
      post(h, "/queue/demo-1/approve"),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 409]);
    expect(
      answers.find((answer) => answer.status === 409)?.body.error,
    ).toContain("is queue:approved");
    expect(tracker.updates().length).toBe(1);
    expect(
      recorded(h).filter((event) => event.kind === "bead.transitioned"),
    ).toEqual([
      {
        kind: "bead.transitioned",
        beadId: "demo-1",
        payload: {
          from: "proposed",
          to: "approved",
          reason: "approve:operator",
        },
      },
    ] as never);
    // Both attempts were authorised and valid: both are audited.
    expect(
      recorded(h).filter((event) => event.kind === "operator.action").length,
    ).toBe(2);
  });

  test("ten mixed actions on one bead: the bead ends in one state, and the transitions in the ledger chain from one to the next", async () => {
    const { h, tracker } = await start([backed("demo-1", "proposed")]);
    const actions = [
      "approve",
      "pause",
      "queue",
      "resume",
      "approve",
      "queue",
      "pause",
      "resume",
      "queue",
      "pause",
    ];
    await Promise.all(
      actions.map((action) => post(h, `/queue/demo-1/${action}`)),
    );
    const moves = recorded(h)
      .filter((event) => event.kind === "bead.transitioned")
      .map((event) => event.payload as { from: string | null; to: string });
    expect(moves.length).toBeGreaterThan(0);
    let at: string | null = "proposed";
    for (const move of moves) {
      expect(move.from).toBe(at);
      at = move.to;
    }
    expect(queueLabels(tracker, "demo-1")).toEqual([`queue:${at}`]);
    // One write per recorded move: a refusal wrote nothing.
    expect(tracker.updates().length).toBe(moves.length);
  });

  test("the hearth takes its home's lock file: while another connection holds it, as a second process of that home would, a move is 409 busy and bd is not called", async () => {
    const { h, tracker } = await start([backed("demo-1", "proposed")]);
    const { Database } = await import("bun:sqlite");
    const holder = new Database(join(h.home, "queue-lock.db"), {
      create: true,
    });
    holder.exec("BEGIN EXCLUSIVE");
    // The hearth waits its full ten seconds for the lock before it answers.
    const answer = await post(h, "/queue/demo-1/approve");
    holder.exec("COMMIT");
    holder.close();
    expect(answer.status).toBe(409);
    expect(answer.body.error).toContain("another queue action is in progress");
    expect(tracker.calls).toEqual([]);
    expect((await post(h, "/queue/demo-1/approve")).status).toBe(200);
  }, 30_000);
});

describe("POST /queue/:id/reassign", () => {
  test("records the smith on the bead; the audit row names the bead and the smith; then one bead.transitioned that names the smith and moves no state", async () => {
    const { h, tracker } = await start([backed("demo-1", "queued")]);
    const answer = await post<QueueReassignResult>(
      h,
      "/queue/demo-1/reassign",
      { smith: "claude-master" },
    );
    expect(answer).toEqual({
      status: 200,
      body: {
        ok: true,
        data: {
          id: "demo-1",
          state: "queued",
          smith: "claude-master",
          recorded: true,
        },
        error: null,
      },
    });
    expect(tracker.updates()).toEqual([
      [
        "update",
        "--set-metadata=smith=claude-master",
        "--json",
        "--",
        "demo-1",
      ],
    ]);
    expect(tracker.beads.get("demo-1")?.metadata).toEqual({
      queue_state: "queued",
      smith: "claude-master",
    });
    expect(recorded(h)).toEqual([
      {
        kind: "operator.action",
        beadId: "demo-1",
        payload: {
          action: "queue.reassign",
          surface: "api",
          target: "claude-master",
        },
      },
      {
        kind: "bead.transitioned",
        beadId: "demo-1",
        payload: { action: "reassign", smith: "claude-master" },
      },
    ] as never);
  });

  test("an open stream gets the audit row and then a bead.transitioned delta for the bead; a /queue read made after that delta shows the new smith", async () => {
    const { h, tracker } = await start([backed("demo-1", "queued")]);
    let enterUpdate: () => void = () => {};
    const updateEntered = new Promise<void>((resolve) => {
      enterUpdate = resolve;
    });
    // GET /queue reads the same in-memory tracker the reassign writes.
    h.bd.answer = async (args) => {
      if (args[0] === "update") {
        enterUpdate();
        // Keep the confirmed POST pending longer than one stream-read budget.
        await Bun.sleep(2200);
      }
      return (
        tracker.answer(args) ??
        answerQueueList(args, [...tracker.beads.values()]) ?? {
          status: 1,
          stdout: "",
          stderr: "Unarranged fixture queue command",
        }
      );
    };
    const smiths = async (): Promise<Array<[string, string | undefined]>> => {
      const response = await fetch(`${h.api}/queue`, { headers: h.headers() });
      const body = (await response.json()) as OperatorEnvelope<QueueEntry[]>;
      return (body.data ?? []).map((entry) => [entry.beadId, entry.smith]);
    };

    const client = await openEventStream(`${h.api}/stream`, {
      Origin: h.hearth.url,
    });
    let posted: Promise<Answer<QueueReassignResult>> | undefined;
    let testFailed = false;
    let testFailure: unknown;
    try {
      const first = await client.next();
      expect(first?.event).toBe("snapshot");
      const snapshot = JSON.parse(first?.data ?? "null") as StreamSnapshot;
      expect(snapshot.queue.data?.map((entry) => entry.smith)).toEqual([
        undefined,
      ]);

      posted = post<QueueReassignResult>(h, "/queue/demo-1/reassign", {
        smith: "claude-master",
      });
      await updateEntered;
      expect((await posted).status).toBe(200);

      const deltas: LedgerEvent[] = [];
      while (deltas.length < 2) {
        const message = await client.next(2000);
        if (message?.event === "delta")
          deltas.push(JSON.parse(message.data) as LedgerEvent);
        else expect(message?.event).toBe("comment");
      }
      expect(
        deltas.map((event) => [event.kind, event.beadId, event.payload]),
      ).toEqual([
        [
          "operator.action",
          "demo-1",
          { action: "queue.reassign", surface: "api", target: "claude-master" },
        ],
        [
          "bead.transitioned",
          "demo-1",
          { action: "reassign", smith: "claude-master" },
        ],
      ]);
      expect(await smiths()).toEqual([["demo-1", "claude-master"]]);
    } catch (error) {
      testFailed = true;
      testFailure = error;
    }
    let cleanupFailure: unknown;
    try {
      if (posted) expect((await posted).status).toBe(200);
    } catch (error) {
      cleanupFailure = error;
    } finally {
      client.close();
    }
    if (testFailed) {
      if (cleanupFailure !== undefined && testFailure instanceof Error)
        Object.defineProperty(testFailure, "cause", {
          value: cleanupFailure,
          configurable: true,
        });
      throw testFailure;
    }
    if (cleanupFailure !== undefined) throw cleanupFailure;
  });

  test("a smith that is not configured, is disabled, or is not a name: 400, nothing appended, bd not called", async () => {
    const { h, tracker } = await start([backed("demo-1", "queued")], {
      files: {
        "agent-forge.toml": [
          "[smiths.claude-apprentice]",
          "enabled = false",
          "",
        ].join("\n"),
      },
    });
    const smiths: unknown[] = [
      "nobody",
      "claude-apprentice",
      "",
      " claude-master",
      "claude-master ",
      "--help",
      "-x",
      "claude-master,claude-journeyman",
      "claude-master\n--add-label=queue:running",
      "smith=claude-master",
      "__proto__",
      "constructor",
      "toString",
      7,
      null,
      ["claude-master"],
      { name: "claude-master" },
      "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ];
    for (const smith of smiths) {
      const answer = await post(h, "/queue/demo-1/reassign", { smith });
      expect({ smith, status: answer.status }).toEqual({ smith, status: 400 });
    }
    expect(h.events()).toEqual([]);
    expect(tracker.calls).toEqual([]);
    // A smith the workspace's own config adds is accepted.
    expect(
      (await post(h, "/queue/demo-1/reassign", { smith: "claude-journeyman" }))
        .status,
    ).toBe(200);
  });

  test("the smiths are read without this process's environment: AGENT_FORGE_SMITH naming no smith changes nothing", async () => {
    const { h } = await start([backed("demo-1", "queued")]);
    const before = process.env["AGENT_FORGE_SMITH"];
    // Read with the environment, this would fail the config: unknown default smith.
    process.env["AGENT_FORGE_SMITH"] = "no-such-smith";
    try {
      const answer = await post(h, "/queue/demo-1/reassign", {
        smith: "claude-master",
      });
      expect(answer.status).toBe(200);
    } finally {
      if (before === undefined) delete process.env["AGENT_FORGE_SMITH"];
      else process.env["AGENT_FORGE_SMITH"] = before;
    }
  });

  test("a config that cannot be read is 500 with nothing recorded and nothing done", async () => {
    const { h, tracker } = await start([backed("demo-1", "queued")], {
      files: { "agent-forge.toml": "[smiths.broken\nthis is not toml" },
    });
    const answer = await post(h, "/queue/demo-1/reassign", {
      smith: "claude-master",
    });
    expect(answer.status).toBe(500);
    expect(h.events()).toEqual([]);
    expect(tracker.calls).toEqual([]);
  });

  test("a bead that is running, in review or done, or not in the queue: 409, audited, nothing written", async () => {
    for (const state of ["running", "review", "done"]) {
      const { h, tracker } = await start([backed("demo-1", state)]);
      const answer = await post(h, "/queue/demo-1/reassign", {
        smith: "claude-master",
      });
      expect({ state, status: answer.status }).toEqual({ state, status: 409 });
      expect(tracker.updates()).toEqual([]);
    }
    const { h, tracker } = await start([{ id: "demo-1" }]);
    expect(
      (await post(h, "/queue/demo-1/reassign", { smith: "claude-master" }))
        .status,
    ).toBe(409);
    expect(tracker.updates()).toEqual([]);
  });
});

describe("POST /queue/:id/propose", () => {
  test("a bead carrying a queue label the queue did not write is put in the queue as proposed: an audit row, one read and one write, then the transition from outside the queue", async () => {
    const { h, tracker } = await start([
      { id: "demo-1", labels: ["queue:queued", "command-center"] },
    ]);
    const answer = await post(h, "/queue/demo-1/propose");
    expect(answer).toEqual({
      status: 200,
      body: {
        ok: true,
        data: {
          id: "demo-1",
          action: "propose",
          from: null,
          to: "proposed",
          recorded: true,
        },
        error: null,
      },
    });
    expect(tracker.calls).toEqual([
      ["show", "--readonly", "--json", "--", "demo-1"],
      [
        "update",
        "--remove-label=queue:queued",
        "--add-label=queue:proposed",
        "--set-metadata=queue_state=proposed",
        "--json",
        "--",
        "demo-1",
      ],
    ]);
    expect(tracker.beads.get("demo-1")?.labels?.sort()).toEqual([
      "command-center",
      "queue:proposed",
    ]);
    expect(tracker.beads.get("demo-1")?.metadata).toEqual({
      queue_state: "proposed",
    });
    expect(recorded(h)).toEqual([
      {
        kind: "operator.action",
        beadId: "demo-1",
        payload: { action: "queue.propose", surface: "api", target: "demo-1" },
      },
      {
        kind: "bead.transitioned",
        beadId: "demo-1",
        payload: { from: null, to: "proposed", reason: "propose:operator" },
      },
    ] as never);
    // Approval is not inherited: the next move is the operator's approve.
    expect((await post(h, "/queue/demo-1/queue")).status).toBe(409);
    expect((await post(h, "/queue/demo-1/approve")).body.data?.to).toBe(
      "approved",
    );
  });

  test("a closed bead is refused 409, with or without a queue label: audited, nothing written, no transition", async () => {
    for (const bead of [
      { id: "demo-1", status: "closed", labels: ["queue:queued"] },
      { id: "demo-1", status: "closed" },
    ] as TrackedBead[]) {
      const { h, tracker } = await start([bead]);
      const answer = await post(h, "/queue/demo-1/propose");
      expect(answer.status).toBe(409);
      expect(answer.body.error ?? "").toContain("closed");
      expect(tracker.updates()).toEqual([]);
      expect(recorded(h).map((event) => event.kind)).toEqual([
        "operator.action",
      ]);
    }
  });

  test("a bead outside the queue is proposed too", async () => {
    const { h, tracker } = await start([{ id: "demo-1" }]);
    const answer = await post(h, "/queue/demo-1/propose");
    expect(answer.status).toBe(200);
    expect(answer.body.data?.to).toBe("proposed");
    expect(queueLabels(tracker, "demo-1")).toEqual(["queue:proposed"]);
  });

  test("a bead in a state the queue wrote, or with two queue labels, is refused 409: audited, nothing written, no transition", async () => {
    const cases: Array<[TrackedBead, string]> = [
      [backed("demo-1", "queued"), "From queued: start"],
      [backed("demo-1", "proposed"), "From proposed: approve"],
      [
        {
          id: "demo-1",
          labels: ["queue:queued", "queue:paused"],
          metadata: { queue_state: "queued" },
        },
        "queue:paused and queue:queued",
      ],
    ];
    for (const [bead, says] of cases) {
      const { h, tracker } = await start([bead]);
      const answer = await post(h, "/queue/demo-1/propose");
      expect({ says, status: answer.status }).toEqual({ says, status: 409 });
      expect(answer.body.error ?? "").toContain(says);
      expect(tracker.updates()).toEqual([]);
      expect(recorded(h).map((event) => event.kind)).toEqual([
        "operator.action",
      ]);
    }
  });
});

describe("GET /queue beside the queue's own writes", () => {
  test("an entry says whether the queue wrote its label", async () => {
    const { h } = await start([]);
    h.bd.list = {
      status: 0,
      stdout: JSON.stringify([
        {
          id: "demo-1",
          title: "Queued by the queue",
          status: "open",
          labels: ["queue:queued"],
          metadata: { queue_state: "queued" },
        },
        {
          id: "demo-1.1",
          title: "A child that inherited the label",
          status: "open",
          labels: ["queue:queued"],
          dependencies: [{ id: "demo-1", metadata: { queue_state: "queued" } }],
        },
      ]),
      stderr: "",
    };
    const response = await fetch(`${h.api}/queue?state=queued`, {
      headers: h.headers(),
    });
    const body = (await response.json()) as OperatorEnvelope<QueueEntry[]>;
    expect(body.data?.map((entry) => [entry.beadId, entry.backed])).toEqual([
      ["demo-1", true],
      ["demo-1.1", false],
    ]);
  });
});

describe("a child created through POST /beads under a bead in the queue", () => {
  test("carries the queue:queued label bd copied and is in no state: GET /queue shows it unbacked, GET /eligibility offers only its parent, every operator row but propose refuses it with nothing written, and propose puts it in the queue as proposed", async () => {
    const { h, tracker } = await start([backed("demo-1", "queued")]);
    // bd create --parent makes the child as bd 1.1.0 does (childOf); every
    // other call is answered by the in-memory tracker.
    h.bd.answer = (args) => {
      const write = readWrite(args);
      if (write?.verb !== "create" || write.parent === undefined)
        return (
          tracker.answer(args) ??
          answerQueueList(args, [...tracker.beads.values()])
        );
      const parent = tracker.beads.get(write.parent);
      if (parent === undefined) throw new Error(`no parent ${write.parent}`);
      const child = childOf(parent, `${parent.id}.1`);
      tracker.beads.set(child.id, child);
      const now = bdTime();
      return bdAnswers.created({
        id: child.id,
        title: write.title,
        issue_type: write.type,
        priority: Number(write.priority),
        status: "open",
        ...(child.labels !== undefined
          ? { labels: [...child.labels].sort() }
          : {}),
        created_at: now,
        updated_at: now,
      });
    };

    const created = await post<{ id: string; labels?: string[] }>(h, "/beads", {
      title: "A child of a queued bead",
      parent: "demo-1",
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      id: "demo-1.1",
      labels: ["queue:queued"],
    });

    const queue = (await (
      await fetch(`${h.api}/queue`, { headers: h.headers() })
    ).json()) as OperatorEnvelope<QueueEntry[]>;
    expect(
      queue.data?.map((entry) => [entry.beadId, entry.state, entry.backed]),
    ).toEqual([
      ["demo-1", "queued", true],
      ["demo-1.1", "queued", false],
    ]);

    const eligibility = (await (
      await fetch(`${h.api}/eligibility`, { headers: h.headers() })
    ).json()) as OperatorEnvelope<{
      eligible: Array<{ id: string }>;
      waiting: Array<{ id: string }>;
    }>;
    expect(eligibility.data?.eligible.map((bead) => bead.id)).toEqual([
      "demo-1",
    ]);
    expect(eligibility.data?.waiting).toEqual([]);

    for (const action of OPERATOR_QUEUE_ACTIONS.filter(
      (each) => each !== "propose",
    )) {
      const answer = await post(h, `/queue/demo-1.1/${action}`);
      expect({ action, status: answer.status }).toEqual({
        action,
        status: 409,
      });
    }
    const reassigned = await post(h, "/queue/demo-1.1/reassign", {
      smith: "claude-master",
    });
    expect(reassigned.status).toBe(409);
    expect(tracker.updates()).toEqual([]);
    expect(queueLabels(tracker, "demo-1.1")).toEqual(["queue:queued"]);
    expect(tracker.beads.get("demo-1.1")?.metadata).toBeUndefined();

    // The create's own event, and nothing that moves a queue state.
    const transitions = h
      .events(["bead.transitioned"])
      .map((event) => event.payload as Record<string, unknown>);
    expect(transitions.map((payload) => payload["action"])).toEqual(["create"]);
    expect(transitions.filter((payload) => "to" in payload)).toEqual([]);

    // Propose is the way in: the child is then proposed, by the queue's own
    // writing, and waits for its own approval.
    const proposed = await post(h, "/queue/demo-1.1/propose");
    expect(proposed.body.data).toEqual({
      id: "demo-1.1",
      action: "propose",
      from: null,
      to: "proposed",
      recorded: true,
    });
    const after = (await (
      await fetch(`${h.api}/queue`, { headers: h.headers() })
    ).json()) as OperatorEnvelope<QueueEntry[]>;
    expect(
      after.data?.map((entry) => [entry.beadId, entry.state, entry.backed]),
    ).toEqual([
      ["demo-1", "queued", true],
      ["demo-1.1", "proposed", true],
    ]);
  });
});
