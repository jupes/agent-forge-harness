import { describe, expect, test } from "bun:test";
import {
  actionState,
  createAppliedStore,
  createBeadWrites,
  createState,
  NO_CONTROL_PLANE,
} from "../../docs/js/islands/bead-writes";
import { createOperatorPost } from "../../docs/js/operator";
import type { BeadOptions, BeadWriteResult } from "../../types/hearth";
import { OPERATOR_HEADER, SURFACE_HEADER, TOKEN_ROUTE } from "../hearth/paths";

const OPTIONS: BeadOptions = {
  types: ["task", "feature", "bug", "chore", "epic"],
  priorities: [
    { value: "P1", tier: "high", meaning: "Urgent" },
    { value: "P2", tier: "medium", meaning: "Default scheduled work" },
  ],
  defaultPriority: "P2",
  limits: {
    title: 200,
    description: 4000,
    acceptance: 2000,
    comment: 4000,
    reason: 1000,
  },
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = () => Response | Promise<Response>;

const envelope = (data: unknown, status = 200): Response =>
  Response.json({ ok: true, data, error: null }, { status });
const refusal = (error: string, status: number): Response =>
  Response.json({ ok: false, data: null, error }, { status });

/** A stand-in control plane: a token, the options, and whatever the test says a write answers. */
function plane(
  write: Reply = () => envelope({}),
  options: Reply | null = null,
) {
  const calls: Call[] = [];
  const fetchImpl = async (
    input: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(
        ([name, value]) => [name.toLowerCase(), value],
      ),
    );
    calls.push({
      url: input,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? JSON.parse(init.body) : null,
    });
    if (input === TOKEN_ROUTE) return envelope({ token: "t-1" });
    if (input === "/__agent-forge/beads/options")
      return options ? options() : envelope(OPTIONS);
    return write();
  };
  return {
    calls,
    writes: createBeadWrites(createOperatorPost(fetchImpl), fetchImpl),
    posts: () => calls.filter((call) => call.method === "POST"),
    optionReads: () =>
      calls.filter((call) => call.url === "/__agent-forge/beads/options")
        .length,
  };
}

const CLAIMED: BeadWriteResult = {
  id: "demo-task",
  action: "claim",
  status: "in_progress",
  assignee: "operator",
  updatedAt: "2026-10-10T12:00:05Z",
  recorded: true,
};

describe("the page's writes", () => {
  test("each write is one POST to its route, with the operator token and the ui surface", async () => {
    const hearth = plane(() => envelope(CLAIMED));
    const { writes } = hearth;

    await writes.create({
      title: "A bead",
      type: "task",
      priority: "P1",
      parent: "demo-epic",
      description: "why",
      acceptance: "- it works",
    });
    await writes.claim("demo-task");
    await writes.comment("demo-task", "worklog: looked");
    await writes.close("demo-task", "Verified");

    expect(
      hearth.posts().map((call) => ({ url: call.url, body: call.body })),
    ).toEqual([
      {
        url: "/__agent-forge/beads",
        body: {
          title: "A bead",
          type: "task",
          priority: "P1",
          parent: "demo-epic",
          description: "why",
          acceptance: "- it works",
        },
      },
      { url: "/__agent-forge/beads/demo-task/claim", body: {} },
      {
        url: "/__agent-forge/beads/demo-task/comment",
        body: { text: "worklog: looked" },
      },
      {
        url: "/__agent-forge/beads/demo-task/close",
        body: { reason: "Verified" },
      },
    ]);
    for (const call of hearth.posts()) {
      expect(call.headers[OPERATOR_HEADER]).toBe("t-1");
      expect(call.headers[SURFACE_HEADER]).toBe("ui");
    }
  });

  test("a create sends only what the form holds: an empty parent, description or acceptance is left out", async () => {
    const hearth = plane(() => envelope({ id: "made-1" }, 201));
    await hearth.writes.create({
      title: "A bead",
      type: "task",
      priority: "P2",
      parent: "",
      description: "",
      acceptance: "  ",
    });
    expect(hearth.posts()[0]?.body).toEqual({
      title: "A bead",
      type: "task",
      priority: "P2",
    });
  });

  test("a confirmed write answers what bd said", async () => {
    const { writes } = plane(() => envelope(CLAIMED));
    expect(await writes.claim("demo-task")).toEqual({
      ok: true,
      data: CLAIMED,
    });
  });

  test("a refusal is shown in the control plane's own words, as a failure and not as an unknown", async () => {
    for (const status of [400, 409, 502, 503]) {
      const { writes } = plane(() =>
        refusal("bd close failed: close children first", status),
      );
      expect(await writes.close("demo-task", "Verified")).toEqual({
        ok: false,
        unknown: false,
        error: "bd close failed: close children first",
      });
    }
  });

  test("a 504 is an unknown outcome: the control plane's message is shown as one", async () => {
    const { writes } = plane(() =>
      refusal(
        "bd create did not finish within its time limit. The change may still have been made. Check with `bd list` before trying again.",
        504,
      ),
    );
    const outcome = await writes.create({
      title: "A bead",
      type: "task",
      priority: "P2",
    });
    expect(outcome).toMatchObject({ ok: false, unknown: true });
    expect(outcome.ok ? "" : outcome.error).toContain(
      "may still have been made",
    );
  });

  test("an answer that is not the control plane's envelope is an unknown outcome, and says how to check", async () => {
    const notEnvelopes: Reply[] = [
      () => new Response("<html>Bad Gateway</html>", { status: 502 }),
      () => new Response("", { status: 200 }),
      () => Response.json({ created: true }, { status: 201 }),
      () => Response.json(null, { status: 200 }),
    ];
    for (const reply of notEnvelopes) {
      const { writes } = plane(reply);
      const claim = await writes.claim("demo-task");
      expect(claim).toMatchObject({ ok: false, unknown: true });
      expect(claim.ok ? "" : claim.error).toContain("bd show demo-task");
      const create = await writes.create({
        title: "A bead",
        type: "task",
        priority: "P2",
      });
      expect(create).toMatchObject({ ok: false, unknown: true });
      expect(create.ok ? "" : create.error).toContain("bd list");
    }
  });

  test("a request that does not complete is an unknown outcome, and nothing is thrown", async () => {
    const { writes } = plane(() => {
      throw new TypeError("Failed to fetch");
    });
    const outcome = await writes.comment("demo-task", "worklog: looked");
    expect(outcome).toMatchObject({ ok: false, unknown: true });
    expect(outcome.ok ? "" : outcome.error).toContain("may have been made");
    expect(outcome.ok ? "" : outcome.error).toContain("bd show demo-task");
  });

  test("an id that is not a Beads id is not sent anywhere", async () => {
    const hearth = plane();
    for (const id of ["", "--help", "../x", "demo task", " demo-task"]) {
      const outcome = await hearth.writes.claim(id);
      expect(outcome).toMatchObject({ ok: false, unknown: false });
    }
    expect(hearth.posts()).toEqual([]);
  });
});

describe("whether a control plane is there", () => {
  test("the options are read once and remembered while they could be read", async () => {
    const hearth = plane();
    expect(await hearth.writes.options()).toEqual({
      available: true,
      options: OPTIONS,
    });
    await hearth.writes.options();
    expect(hearth.optionReads()).toBe(1);
  });

  test("with no control plane the page says so, and asks again the next time", async () => {
    let up = false;
    const hearth = plane(
      () => envelope({}),
      () =>
        up
          ? envelope(OPTIONS)
          : new Response("<html>Not Found</html>", { status: 404 }),
    );
    expect(await hearth.writes.options()).toEqual({
      available: false,
      reason: NO_CONTROL_PLANE,
    });
    expect(await hearth.writes.options()).toEqual({
      available: false,
      reason: NO_CONTROL_PLANE,
    });
    up = true;
    expect(await hearth.writes.options()).toMatchObject({ available: true });
    expect(hearth.optionReads()).toBe(3);
  });

  test("an options answer that is not the control plane's, or a fetch that fails, is no control plane", async () => {
    const replies: Reply[] = [
      () => Response.json({ ok: true, data: { types: "task" }, error: null }),
      () => refusal("not for you", 403),
      () => {
        throw new TypeError("Failed to fetch");
      },
    ];
    for (const reply of replies) {
      const hearth = plane(() => envelope({}), reply);
      expect(await hearth.writes.options()).toEqual({
        available: false,
        reason: NO_CONTROL_PLANE,
      });
    }
  });

  test("with no control plane a write is refused on the page and nothing is posted", async () => {
    const hearth = plane(
      () => envelope(CLAIMED),
      () => new Response("", { status: 404 }),
    );
    expect(await hearth.writes.claim("demo-task")).toEqual({
      ok: false,
      unknown: false,
      error: NO_CONTROL_PLANE,
    });
    expect(hearth.posts()).toEqual([]);
  });
});

describe("which actions a bead is offered", () => {
  const live = { available: true } as const;

  test("an open bead can be claimed, commented on and closed", () => {
    expect(actionState({ ...live, status: "open" })).toEqual({
      claim: { enabled: true },
      comment: { enabled: true },
      close: { enabled: true },
    });
  });

  test("a bead in progress is not offered a claim, and says why", () => {
    const state = actionState({ ...live, status: "in_progress" });
    expect(state.claim).toEqual({
      enabled: false,
      reason: expect.stringContaining("in progress"),
    });
    expect(state.comment.enabled).toBe(true);
    expect(state.close.enabled).toBe(true);
  });

  test("a closed bead can only be commented on", () => {
    const state = actionState({ ...live, status: "closed" });
    expect(state.claim).toEqual({
      enabled: false,
      reason: expect.stringContaining("closed"),
    });
    expect(state.close).toEqual({
      enabled: false,
      reason: expect.stringContaining("closed"),
    });
    expect(state.comment.enabled).toBe(true);
  });

  test("with no control plane nothing is offered, and each says why", () => {
    const state = actionState({
      available: false,
      reason: NO_CONTROL_PLANE,
      status: "open",
    });
    for (const offer of [state.claim, state.comment, state.close])
      expect(offer).toEqual({ enabled: false, reason: NO_CONTROL_PLANE });
  });
});

describe("whether Create may be pressed", () => {
  const live = { available: true } as const;

  test("with a control plane, no labels and the harness's own tracker: yes", () => {
    for (const repo of [".", "", "  .  "])
      expect(createState({ ...live, labels: "", repo })).toEqual({
        enabled: true,
      });
    expect(createState({ ...live, labels: " , ", repo: "." })).toEqual({
      enabled: true,
    });
  });

  test("with labels typed: no, because Create would not send them", () => {
    expect(createState({ ...live, labels: "dashboard,ui", repo: "." })).toEqual(
      { enabled: false, reason: expect.stringContaining("Labels") },
    );
  });

  test("with another repo named: no, because Create files in this checkout's tracker", () => {
    expect(
      createState({ ...live, labels: "", repo: "./repos/elsewhere" }),
    ).toEqual({ enabled: false, reason: expect.stringContaining("Repo") });
  });

  test("with no control plane: no, with that reason first", () => {
    expect(
      createState({
        available: false,
        reason: NO_CONTROL_PLANE,
        labels: "dashboard",
        repo: ".",
      }),
    ).toEqual({ enabled: false, reason: NO_CONTROL_PLANE });
  });
});

/** A `sessionStorage` of the test's own. */
function memory(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string): string | null => items.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      items.set(key, value);
    },
  };
}

const COMMENTED: BeadWriteResult = {
  id: "demo-task",
  action: "comment",
  comment: {
    id: "c-1",
    author: "operator",
    createdAt: "2026-10-10T12:00:09Z",
  },
  recorded: true,
};

describe("what this page's actions changed", () => {
  test("an answer is kept by bead id, and is there again for a second store over the same storage (a reload)", () => {
    const storage = memory();
    const first = createAppliedStore(storage);
    first.record(CLAIMED);
    first.record(COMMENTED, { text: "worklog: looked" });

    const afterReload = createAppliedStore(storage);
    expect(afterReload.get("demo-task")).toMatchObject({
      id: "demo-task",
      status: "in_progress",
      assignee: "operator",
      updatedAt: "2026-10-10T12:00:05Z",
      comments: [
        {
          id: "c-1",
          author: "operator",
          createdAt: "2026-10-10T12:00:09Z",
          text: "worklog: looked",
        },
      ],
    });
    expect(afterReload.get("demo-other")).toBeUndefined();
  });

  test("a created bead is remembered with what the page sent, newest first", () => {
    const store = createAppliedStore(memory());
    store.record(
      { id: "made-1", action: "create", status: "open", recorded: true },
      { created: { title: "First", type: "epic", priority: "P2" } },
    );
    store.record(
      { id: "made-1.1", action: "create", status: "open", recorded: true },
      {
        created: {
          title: "Second",
          type: "task",
          priority: "P1",
          parent: "made-1",
        },
      },
    );
    expect(store.created().map((bead) => bead.id)).toEqual([
      "made-1.1",
      "made-1",
    ]);
    expect(store.created()[0]?.created).toEqual({
      title: "Second",
      type: "task",
      priority: "P1",
      parent: "made-1",
    });
  });

  test("a storage that throws does not break a write: the store works for the life of the page", () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error("SecurityError");
      },
      setItem: (): void => {
        throw new Error("QuotaExceededError");
      },
    };
    const store = createAppliedStore(broken);
    store.record(CLAIMED);
    expect(store.get("demo-task")?.status).toBe("in_progress");
    expect(createAppliedStore(null).get("demo-task")).toBeUndefined();
  });

  test("what the storage holds is not trusted: a text that is not the store's, or an id that is not a Beads id, is left out", () => {
    const key = "agent-forge.bead-writes.v1";
    expect(
      createAppliedStore(memory({ [key]: "{not json" })).created(),
    ).toEqual([]);
    expect(
      createAppliedStore(memory({ [key]: '{"beads":"x"}' })).created(),
    ).toEqual([]);
    const tampered = createAppliedStore(
      memory({
        [key]: JSON.stringify({
          beads: [
            { id: "../../etc", status: "open", comments: [], at: 3 },
            { id: "--help", status: "open", comments: [], at: 2 },
            { id: "demo-kept", status: "closed", comments: [], at: 1 },
            { id: 7, comments: [] },
            null,
          ],
        }),
      }),
    );
    expect(tampered.get("../../etc")).toBeUndefined();
    expect(tampered.get("--help")).toBeUndefined();
    expect(tampered.get("demo-kept")?.status).toBe("closed");
  });

  test("the 51st bead evicts the one changed longest ago", () => {
    const store = createAppliedStore(memory());
    for (let n = 1; n <= 51; n++)
      store.record({
        id: `demo-${n}`,
        action: "claim",
        status: "in_progress",
        recorded: true,
      });
    expect(store.get("demo-1")).toBeUndefined();
    expect(store.get("demo-2")?.status).toBe("in_progress");
    expect(store.get("demo-51")?.status).toBe("in_progress");
  });

  test("a listener is told when something is recorded, until it leaves", () => {
    const store = createAppliedStore(memory());
    let told = 0;
    const leave = store.subscribe(() => {
      told++;
    });
    store.record(CLAIMED);
    leave();
    store.record(COMMENTED, { text: "worklog: looked" });
    expect(told).toBe(1);
  });
});

describe("when the snapshot is read again", () => {
  const claimedAndCommented = () => {
    const store = createAppliedStore(memory());
    store.record(CLAIMED);
    store.record(COMMENTED, { text: "worklog: looked" });
    return store;
  };
  const issue = (
    status: string,
    updatedAt: string,
    comments: string[] = [],
  ) => ({
    status,
    updatedAt,
    comments: comments.map((body) => ({ body })),
  });

  test("an issue that agrees drops the status: the snapshot has caught up", () => {
    const store = claimedAndCommented();
    store.reconcile("demo-task", issue("in_progress", "2026-10-10T12:00:05Z"));
    expect(store.get("demo-task")?.status).toBeUndefined();
    expect(store.get("demo-task")?.assignee).toBeUndefined();
    expect(store.get("demo-task")?.comments).toHaveLength(1);
  });

  test("an issue changed later, to another status, drops it too: a change made elsewhere is not masked", () => {
    const store = claimedAndCommented();
    store.reconcile("demo-task", issue("closed", "2026-10-10T12:30:00Z"));
    expect(store.get("demo-task")?.status).toBeUndefined();
  });

  test("an issue that has not changed keeps it: a stale snapshot, or one only regenerated, drops nothing", () => {
    const store = claimedAndCommented();
    store.reconcile("demo-task", issue("open", "2026-07-25T09:00:00Z"));
    store.reconcile("demo-task", issue("open", "2026-10-10T12:00:05Z"));
    expect(store.get("demo-task")).toMatchObject({
      status: "in_progress",
      assignee: "operator",
    });
    expect(store.get("demo-task")?.comments).toHaveLength(1);
  });

  test("a comment the issue now has is dropped; one it lacks is kept", () => {
    const store = claimedAndCommented();
    store.reconcile(
      "demo-task",
      issue("open", "2026-07-25T09:00:00Z", ["another comment"]),
    );
    expect(store.get("demo-task")?.comments).toHaveLength(1);
    store.reconcile(
      "demo-task",
      issue("open", "2026-07-25T09:00:00Z", ["worklog: looked"]),
    );
    expect(store.get("demo-task")?.comments).toEqual([]);
  });

  test("an entry with nothing left is forgotten, and a bead found in the snapshot is no longer 'created here'", () => {
    const store = createAppliedStore(memory());
    store.record(
      { id: "made-1", action: "create", status: "open", recorded: true },
      { created: { title: "First", type: "task", priority: "P2" } },
    );
    store.reconcile("made-1", issue("open", "2026-10-10T12:00:00Z"));
    expect(store.get("made-1")).toBeUndefined();
    expect(store.created()).toEqual([]);
  });

  test("reconciling a bead the store does not hold changes nothing", () => {
    const store = claimedAndCommented();
    store.reconcile("demo-other", issue("closed", "2026-10-10T12:30:00Z"));
    expect(store.get("demo-task")?.status).toBe("in_progress");
  });
});

describe("an answer that says done without saying what was written", () => {
  test("a 2xx envelope with no result, or with an id that is not a Beads id, is an unknown outcome, not a done one", async () => {
    const answers: unknown[] = [
      {},
      null,
      { id: "demo-task" },
      { action: "claim" },
      { id: "--force", action: "claim" },
      { id: " demo-task", action: "claim" },
      { id: 7, action: "claim" },
      "done",
    ];
    for (const data of answers) {
      const { writes } = plane(() => envelope(data));
      const outcome = await writes.claim("demo-task");
      expect({ data, ok: outcome.ok }).toEqual({ data, ok: false });
      expect(outcome).toMatchObject({ unknown: true });
      expect(outcome.ok ? "" : outcome.error).toContain("bd show demo-task");
    }
  });
});

describe("what the store keeps of a text, and in what order", () => {
  test("a comment is kept as the control plane hands it to bd: CR LF as LF, so the snapshot's copy is recognised", () => {
    const store = createAppliedStore(memory());
    store.record(COMMENTED, { text: "first line\r\nsecond line\rthird" });
    expect(store.get("demo-task")?.comments[0]?.text).toBe(
      "first line\nsecond line\nthird",
    );
    // A snapshot that spells the line ends the other way is the same comment.
    store.reconcile("demo-task", {
      status: "open",
      updatedAt: "2026-07-25T09:00:00Z",
      comments: [{ body: "first line\r\nsecond line\r\nthird" }],
    });
    expect(store.get("demo-task")).toBeUndefined();
  });

  test("a bead created after a reload is newer than the ones created before it", () => {
    const storage = memory();
    const before = createAppliedStore(storage);
    for (const id of ["made-1", "made-2"])
      before.record(
        { id, action: "create", status: "open", recorded: true },
        { created: { title: id, type: "task", priority: "P2" } },
      );
    const afterReload = createAppliedStore(storage);
    afterReload.record(
      { id: "made-3", action: "create", status: "open", recorded: true },
      { created: { title: "made-3", type: "task", priority: "P2" } },
    );
    expect(afterReload.created().map((bead) => bead.id)).toEqual([
      "made-3",
      "made-2",
      "made-1",
    ]);
  });

  test("a stored field of the wrong kind is left out, not shown", () => {
    const store = createAppliedStore(
      memory({
        "agent-forge.bead-writes.v1": JSON.stringify({
          beads: [
            {
              id: "demo-task",
              status: 7,
              assignee: { name: "x" },
              updatedAt: ["now"],
              labels: ["kept", 7, null],
              comments: [
                { id: "c-1", author: "a", createdAt: "t", text: "kept" },
                { id: "c-2", author: "a", createdAt: "t", text: 7 },
                "not a comment",
              ],
              created: { title: 7, type: "task", priority: "P2" },
              at: "soon",
            },
          ],
        }),
      }),
    );
    expect(store.get("demo-task")).toEqual({
      id: "demo-task",
      labels: ["kept"],
      comments: [{ id: "c-1", author: "a", createdAt: "t", text: "kept" }],
      at: 0,
    });
  });
});

describe("a write whose answer the page does not have", () => {
  test("while the answer is awaited on this page it is not listed; a refusal or a confirmation ends it", () => {
    const store = createAppliedStore(memory());
    const first = store.begin({ action: "claim", id: "demo-task" });
    const second = store.begin({ action: "comment", id: "demo-task" });
    expect(
      store.notices().filter((notice) => notice.id === "demo-task"),
    ).toEqual([]);
    store.settle(first);
    store.settle(second);
    expect(
      store.notices().filter((notice) => notice.id === "demo-task"),
    ).toEqual([]);
  });

  test("an answer that leaves the outcome unknown is kept, with what was said, until it is dismissed", () => {
    const store = createAppliedStore(memory());
    const key = store.begin({ action: "comment", id: "demo-task" });
    store.unknown(key, "bd comments add did not finish within its time limit.");
    expect(
      store.notices().filter((notice) => notice.id === "demo-task"),
    ).toEqual([
      {
        key,
        action: "comment",
        id: "demo-task",
        at: expect.any(Number),
        outcome: "unknown",
        message: "bd comments add did not finish within its time limit.",
      },
    ]);
    expect(
      store.notices().filter((notice) => notice.id === "demo-other"),
    ).toEqual([]);
    expect(
      store.notices().filter((notice) => notice.action === "create"),
    ).toEqual([]);
    store.dismiss(key);
    expect(
      store.notices().filter((notice) => notice.id === "demo-task"),
    ).toEqual([]);
  });

  test("a write still awaited when the page is reloaded is listed afterwards: the page that would have shown its answer is gone", () => {
    const storage = memory();
    const page = createAppliedStore(storage);
    const settled = page.begin({ action: "claim", id: "demo-task" });
    page.settle(settled);
    // Begun last: each is in storage from the moment it is sent, not from the
    // next change to the store.
    page.begin({ action: "create", title: "A bead in flight" });
    page.begin({ action: "close", id: "demo-task" });

    const afterReload = createAppliedStore(storage);
    expect(
      afterReload.notices().filter((notice) => notice.action === "create"),
    ).toEqual([
      {
        key: expect.any(String),
        action: "create",
        title: "A bead in flight",
        at: expect.any(Number),
        outcome: "unknown",
        message: expect.stringContaining("reloaded before the answer"),
      },
    ]);
    expect(
      afterReload.notices().filter((notice) => notice.id === "demo-task"),
    ).toEqual([
      {
        key: expect.any(String),
        action: "close",
        id: "demo-task",
        at: expect.any(Number),
        outcome: "unknown",
        message: expect.stringContaining("reloaded before the answer"),
      },
    ]);
    // And it stays listed across another reload, until it is dismissed.
    const again = createAppliedStore(storage);
    const [left] = again
      .notices()
      .filter((notice) => notice.id === "demo-task");
    expect(left?.action).toBe("close");
    again.dismiss(left?.key ?? "");
    expect(
      createAppliedStore(storage)
        .notices()
        .filter((notice) => notice.id === "demo-task"),
    ).toEqual([]);
  });

  test("a listener is told when one becomes unknown or is dismissed", () => {
    const store = createAppliedStore(memory());
    let told = 0;
    store.subscribe(() => {
      told++;
    });
    const key = store.begin({ action: "claim", id: "demo-task" });
    const sent = told;
    store.unknown(key, "not known");
    expect(told).toBe(sent + 1);
    store.dismiss(key);
    expect(told).toBe(sent + 2);
    // Nothing is told for a key the store does not hold.
    store.dismiss(key);
    store.unknown(key, "gone");
    store.settle(key);
    expect(told).toBe(sent + 2);
  });

  test("what storage holds about them is not trusted, and a storage that throws does not break a write", () => {
    const tampered = createAppliedStore(
      memory({
        "agent-forge.bead-writes.v1": JSON.stringify({
          beads: [],
          attempts: [
            { key: "a", action: "claim", id: "--help", at: 1, message: "x" },
            {
              key: "b",
              action: "delete",
              id: "demo-task",
              at: 1,
              message: "x",
            },
            { key: "c", action: "claim", id: "demo-task", at: 1, message: 7 },
            {
              key: "d",
              action: "claim",
              id: "demo-task",
              at: 1,
              message: "kept",
            },
            { action: "claim", id: "demo-task", at: 1, message: "no key" },
            "not an attempt",
          ],
        }),
      }),
    );
    expect(
      tampered
        .notices()
        .filter((notice) => notice.id === "demo-task")
        .map((attempt) => attempt.key),
    ).toEqual(["d"]);
    expect(
      tampered.notices().filter((notice) => notice.id === "--help"),
    ).toEqual([]);
    expect(
      tampered.notices().filter((notice) => notice.action === "create"),
    ).toEqual([]);

    const broken = createAppliedStore({
      getItem: (): string | null => {
        throw new Error("SecurityError");
      },
      setItem: (): void => {
        throw new Error("QuotaExceededError");
      },
    });
    const key = broken.begin({ action: "claim", id: "demo-task" });
    broken.unknown(key, "not known");
    expect(
      broken.notices().filter((notice) => notice.id === "demo-task"),
    ).toHaveLength(1);
  });

  test("only the twenty most recent are kept", () => {
    const store = createAppliedStore(memory());
    for (let n = 1; n <= 25; n++)
      store.unknown(store.begin({ action: "claim", id: "demo-task" }), `n${n}`);
    const kept = store
      .notices()
      .filter((notice) => notice.id === "demo-task")
      .map((attempt) => attempt.message);
    expect(kept).toHaveLength(20);
    expect(kept[0]).toBe("n6");
    expect(kept.at(-1)).toBe("n25");
  });
});

describe("writes the page is waiting on, and the notices it keeps", () => {
  test("awaiting lists the writes sent for a bead and not yet answered, and the creates without an id; answered or unknown ones are not among them", () => {
    const store = createAppliedStore(memory());
    const claim = store.begin({ action: "claim", id: "demo-task" });
    const comment = store.begin({ action: "comment", id: "demo-task" });
    store.begin({ action: "close", id: "demo-other" });
    const create = store.begin({ action: "create", title: "New one" });
    expect(store.awaiting("demo-task").map((write) => write.key)).toEqual([
      claim,
      comment,
    ]);
    expect(store.awaiting().map((write) => write.key)).toEqual([create]);
    store.settle(claim);
    store.unknown(comment, "no answer");
    expect(store.awaiting("demo-task")).toEqual([]);
  });

  test("a refusal kept as refused is a notice with its outcome, outlives a reload, and goes when it is dismissed", () => {
    const storage = memory();
    const store = createAppliedStore(storage);
    const key = store.begin({ action: "close", id: "demo-task" });
    store.refused(key, "bd close failed: no issue found");
    const expected = {
      key,
      action: "close",
      id: "demo-task",
      at: expect.any(Number),
      outcome: "refused",
      message: "bd close failed: no issue found",
    } as const;
    expect(store.notices()).toEqual([expected]);
    expect(store.awaiting("demo-task")).toEqual([]);
    const reloaded = createAppliedStore(storage);
    expect(reloaded.notices()).toEqual([expected]);
    reloaded.dismiss(key);
    expect(createAppliedStore(storage).notices()).toEqual([]);
  });

  test("notices lists every unknown or refused write, for any bead and the creates, oldest first", () => {
    const store = createAppliedStore(memory());
    const a = store.begin({ action: "claim", id: "demo-a" });
    const create = store.begin({ action: "create", title: "T" });
    const b = store.begin({ action: "close", id: "demo-b" });
    store.begin({ action: "comment", id: "demo-a" });
    store.refused(b, "refused");
    store.unknown(a, "unknown");
    store.unknown(create, "unknown create");
    expect(
      store.notices().map((notice) => [notice.key, notice.outcome]),
    ).toEqual([
      [a, "unknown"],
      [create, "unknown"],
      [b, "refused"],
    ]);
  });

  test("an attempt stored with a message and no outcome, as an older page kept it, is read as unknown", () => {
    const storage = memory({
      "agent-forge.bead-writes.v1": JSON.stringify({
        beads: [],
        attempts: [
          {
            key: "w3",
            action: "claim",
            id: "demo-task",
            at: 3,
            message: "kept by an older page",
          },
        ],
      }),
    });
    expect(createAppliedStore(storage).notices()).toEqual([
      {
        key: "w3",
        action: "claim",
        id: "demo-task",
        at: 3,
        outcome: "unknown",
        message: "kept by an older page",
      },
    ]);
  });
});
