import { expect, test } from "bun:test";
import { createDesktopBeadWrites } from "../../apps/desktop/src/bead-writes-client";
import type { ActionOutcome } from "../../docs/js/action-outcome";

const scope = {
  projectId: "project-a5832fa0-7a21-403b-8184-44892f0d8d86",
  workspace: "/fixture",
};
function fixture(
  post: (action: string, body: unknown) => Promise<ActionOutcome>,
) {
  const kept = new Map<string, string>();
  const storage = {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, text: string) => {
      kept.set(key, text);
    },
  };
  let number = 0;
  let tail = Promise.resolve();
  const deps = {
    storage,
    requestId: () => `write-${++number}`,
    canWrite: () => true,
    post: (
      _scope: typeof scope,
      action: string,
      _id: string | null,
      body: unknown,
    ) => post(action, body),
    changed: () => {},
    withJournalLock<T>(work: () => Promise<T>): Promise<T> {
      const run = tail.then(work);
      tail = run.then(
        () => {},
        () => {},
      );
      return run;
    },
  };
  return { deps, storage, kept, client: createDesktopBeadWrites(deps) };
}

test("a lost create stays held across navigation and reload, saves no private body and never repeats", async () => {
  let release: (value: ActionOutcome) => void = () => {};
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const fields = {
    title: "Light the lantern",
    parent: "alpha-epic",
    description: "PRIVATE-DESCRIPTION",
    acceptance: "PRIVATE-AC",
  };
  const work = f.client.create(scope, fields, "open");
  await Bun.sleep(0);
  expect(f.client.held(scope)).toBe(true);
  await f.client.create(scope, fields, "open");
  expect(calls).toBe(1);
  release({ state: "unknown", message: "The reply was lost. Check the bead." });
  await work;
  const text = [...f.kept.values()].join("");
  expect(text).not.toContain("PRIVATE-");
  const reloaded = createDesktopBeadWrites(f.deps);
  expect(reloaded.held(scope)).toBe(true);
  await reloaded.create(scope, fields, "open");
  expect(calls).toBe(1);
  expect(reloaded.notices()[0]?.phase).toBe("unknown");
});

const fields = { title: "Light the lantern", parent: "alpha-epic" };
const created = (recorded = true): ActionOutcome => ({
  state: "done",
  data: { id: "alpha-1", action: "create", status: "open", recorded },
});

test("a lost Proposed reply retains the created id before sending and cannot create again after reload", async () => {
  const calls: string[] = [];
  const f = fixture(async (action) => {
    calls.push(action);
    if (action === "create") return created();
    expect([...f.kept.values()].join("")).toContain('"createdId":"alpha-1"');
    expect([...f.kept.values()].join("")).toContain('"stage":"propose"');
    return { state: "unknown", message: "Reply lost" };
  });
  const result = await f.client.create(scope, fields, "proposed");
  expect(result?.createdId).toBe("alpha-1");
  expect(result?.phase).toBe("unknown");
  const reload = createDesktopBeadWrites(f.deps);
  await reload.create(scope, fields, "proposed");
  expect(calls).toEqual(["create", "propose"]);
  expect(reload.notices()[0]?.createdId).toBe("alpha-1");
});

test("connection loss between create and Proposed keeps the created bead without a second effect", async () => {
  let allowed = true;
  const calls: string[] = [];
  const f = fixture(async (action) => {
    calls.push(action);
    allowed = false;
    return created();
  });
  f.deps.canWrite = () => allowed;
  const result = await f.client.create(scope, fields, "proposed");
  expect(calls).toEqual(["create"]);
  expect(result?.createdId).toBe("alpha-1");
  expect(result?.phase).toBe("refused");
  expect(result?.message).toContain("Proposed was not sent");
});

test("unwritable or corrupt saved history refuses before any effect and preserves existing bytes", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return created();
  });
  f.storage.setItem = () => {
    throw Error("Storage full");
  };
  expect((await f.client.create(scope, fields, "open"))?.phase).toBe("refused");
  expect(calls).toBe(0);
  const corrupt = "{future or damaged}";
  f.storage.getItem = () => corrupt;
  const reload = createDesktopBeadWrites(f.deps);
  expect(reload.held(scope)).toBe(true);
  expect(await reload.create(scope, fields, "open")).toBeNull();
  expect(f.storage.getItem("history")).toBe(corrupt);
  expect(calls).toBe(0);
});

test("wrong action or bead, and a blank claim identity, remain unknown rather than Done", async () => {
  for (const data of [
    { id: "alpha-1", action: "close", status: "closed", recorded: true },
    {
      id: "foreign-1",
      action: "claim",
      status: "in_progress",
      assignee: "smith",
      recorded: true,
    },
    {
      id: "alpha-1",
      action: "claim",
      status: "in_progress",
      assignee: "  ",
      recorded: true,
    },
  ]) {
    const f = fixture(async () => ({ state: "done", data }));
    expect((await f.client.act(scope, "claim", "alpha-1"))?.phase).toBe(
      "unknown",
    );
    expect(f.client.held(scope)).toBe(true);
  }
});

test("pending Windows scope aliases stay held, another project is independent, and Sending cannot be dismissed", async () => {
  let release: (value: ActionOutcome) => void = () => {};
  const f = fixture(
    async () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const windows = { ...scope, workspace: "C:\\Fixture\\" };
  const work = f.client.create(windows, fields, "open");
  await Bun.sleep(0);
  const key = f.client.notices()[0]?.key ?? "missing";
  expect(f.client.held({ ...scope, workspace: "c:/fixture" })).toBe(true);
  expect(f.client.held({ ...windows, projectId: "other" })).toBe(false);
  expect(await f.client.checked(key)).toBe(false);
  release({ state: "refused", message: "Parent no longer available" });
  await work;
  expect(f.client.held(windows)).toBe(false);
  expect(await f.client.checked(key)).toBe(true);
});

test("confirmed writes survive a refresh callback error and report either missing Activity record", async () => {
  const f = fixture(async (action) =>
    action === "create"
      ? created(false)
      : {
          state: "done",
          data: {
            action: "propose",
            id: "alpha-1",
            from: null,
            to: "proposed",
            recorded: true,
          },
        },
  );
  f.deps.changed = () => {
    throw Error("Unmounted view");
  };
  const result = await f.client.create(scope, fields, "proposed");
  expect(result?.phase).toBe("done");
  expect(result?.message).toContain("Activity record could not be stored");
  expect(f.client.held(scope)).toBe(false);
});

test("two windows preserve each other's unknown writes and recheck shared history before any new effect", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { state: "unknown", message: "Lost reply" };
  });
  const second = createDesktopBeadWrites(f.deps);
  const other = { ...scope, projectId: "project-b" };
  await Promise.all([
    f.client.create(scope, fields, "open"),
    second.create(other, fields, "open"),
  ]);
  const reloaded = createDesktopBeadWrites(f.deps);
  expect(reloaded.notices()).toHaveLength(2);
  expect(reloaded.held(scope)).toBe(true);
  expect(reloaded.held(other)).toBe(true);
  await second.create(scope, fields, "open");
  expect(calls).toBe(2);
  const first = reloaded
    .notices()
    .find((item) => item.projectId === scope.projectId);
  if (!first) throw Error("Missing first window's unknown write");
  expect(await reloaded.checked(first.key)).toBe(true);
  const after = createDesktopBeadWrites(f.deps);
  expect(after.held(scope)).toBe(false);
  expect(after.held(other)).toBe(true);
});

test("waiting for another window's journal lock cannot change the reviewed create body", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: unknown[] = [];
  const f = fixture(async (_action, body) => {
    sent.push(body);
    if (sent.length === 1) await gate;
    return { state: "unknown", message: "Lost reply" };
  });
  const first = f.client.create(scope, fields, "open");
  await Bun.sleep(0);
  const other = createDesktopBeadWrites(f.deps);
  const reviewed = { ...fields, title: "Keep the reviewed title" };
  const second = other.create(
    { ...scope, projectId: "project-b" },
    reviewed,
    "open",
  );
  reviewed.title = "Changed while waiting";
  release();
  await Promise.all([first, second]);
  expect(sent[1]).toMatchObject({ title: "Keep the reviewed title" });
});
