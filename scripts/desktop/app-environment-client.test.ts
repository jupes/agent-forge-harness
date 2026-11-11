import { expect, test } from "bun:test";
import { EnvironmentSettingsView } from "../../apps/desktop/src/AppEnvironmentSettings";
import { createEnvironmentSettingsClient } from "../../apps/desktop/src/app-environment-client";
import type {
  EnvironmentRequest,
  EnvironmentStatus,
} from "../config/environment-protocol";
import { attrs, findAll, textOf } from "../dashboard/ds/vnode";

const id = "ae000000-0000-4000-8000-000000000001";
const ready: EnvironmentStatus = {
  version: 1,
  ownerKey: "a".repeat(64),
  target: "user",
  file: "/machine/config.toml",
  names: ["OLD"],
  baseNames: ["PATH"],
  provenance: "/machine/config.toml",
  revision: { user: "b".repeat(64), workspace: "c".repeat(64) },
  record: { version: 1, revision: 0, last: null },
  checkedAt: "2026-11-11T04:00:00Z",
  canSave: true,
};
const answer = (data: EnvironmentStatus) =>
  Response.json({ ok: true, data, error: null });
function storage() {
  let text: string | null = null;
  return {
    getItem: () => text,
    setItem(_key: string, value: string) {
      text = value;
    },
    removeItem() {
      text = null;
    },
  };
}
function completed(request: EnvironmentRequest): EnvironmentStatus {
  return {
    ...ready,
    names: [...request.names],
    record: {
      version: 1,
      revision: 1,
      last: {
        request,
        state: "completed",
        candidateHash: "d".repeat(64),
        startedAt: ready.checkedAt,
        finishedAt: ready.checkedAt,
      },
    },
  };
}
test("draft and Cancel write nothing; reviewed Save persists exact intent before one POST and verifies its receipt", async () => {
  const stored = storage();
  let calls = 0,
    current = ready;
  const client = createEnvironmentSettingsClient({
    storage: stored,
    requestId: () => id,
    canAct: () => true,
    changed() {},
    read: async () => answer(current),
    post: async (request) => {
      calls++;
      expect(stored.getItem()).toBe(JSON.stringify(request));
      current = completed(request);
      return answer(current);
    },
  });
  await client.check();
  client.edit("NEW");
  client.cancel();
  expect(calls).toBe(0);
  expect(client.state.draft).toBe("OLD");
  client.edit("NEW");
  await client.save();
  expect(calls).toBe(0);
  client.review();
  await client.save();
  expect(calls).toBe(1);
  expect(client.state.pending).toBeNull();
  expect(client.state.confirmed?.requestId).toBe(id);
  expect(client.state.data?.names).toEqual(["NEW"]);
  expect(stored.getItem()).toBeNull();
});

test("lost replies survive reload and matching current names do not replace an exact historical receipt", async () => {
  const stored = storage();
  let reads = ready,
    calls = 0;
  const dependencies = {
    storage: stored,
    requestId: () => id,
    canAct: () => true,
    changed() {},
    read: async () => answer(reads),
    post: async (_request: EnvironmentRequest): Promise<Response> => {
      calls++;
      throw Error("reply lost");
    },
  };
  const first = createEnvironmentSettingsClient(dependencies);
  await first.check();
  first.edit("NEW");
  first.review();
  await first.save();
  const original = first.state.pending;
  expect(original).not.toBeNull();
  first.dispose();
  const client = createEnvironmentSettingsClient(dependencies);
  reads = { ...ready, names: ["NEW"] };
  await client.check();
  expect(client.state.pending).toEqual(original);
  expect(client.canReview()).toBe(false);
  if (!original) throw Error("Missing original");
  reads = completed({ ...original, names: ["WRONG"] });
  await client.check();
  expect(client.state.pending).toEqual(original);
  // A later exact receipt clears uncertainty even when a separate current config read differs.
  reads = {
    ...completed(original),
    record: {
      ...completed(original).record,
      revision: 2,
      last: {
        ...completed(original).record.last!,
        request: { ...original, expectedJournalRevision: 1 },
      },
    },
  };
  await client.check();
  expect(client.state.pending).toEqual(original);
  // New window has no contradictory history baseline from the deliberately wrong fixtures above.
  client.dispose();
  const recovered = createEnvironmentSettingsClient(dependencies);
  reads = { ...completed(original), names: ["EXTERNAL"] };
  await recovered.check();
  expect(recovered.state.pending).toBeNull();
  expect(recovered.state.confirmed?.names).toEqual(["NEW"]);
  expect(recovered.state.data?.names).toEqual(["EXTERNAL"]);
  expect(recovered.state.draft).toBe("NEW");
  expect(recovered.canSave()).toBe(false);
  expect(calls).toBe(1);
});

test("a stale refresh after a confirmed POST preserves the confirmed receipt and holds Save", async () => {
  const client = createEnvironmentSettingsClient({
    storage: storage(),
    requestId: () => id,
    canAct: () => true,
    changed() {},
    read: async () => answer(ready),
    post: async (request) => answer(completed(request)),
  });
  await client.check();
  client.edit("NEW");
  client.review();
  await client.save();
  expect(client.state.pending).toBeNull();
  expect(client.state.confirmed?.requestId).toBe(id);
  expect(client.state.data?.record.revision).toBe(1);
  expect(client.state.fresh).toBe(false);
  expect(client.canSave()).toBe(false);
});

test("Check can advance the same exact pending record to completed without replay, but cannot regress its terminal receipt", async () => {
  let snapshot = ready,
    calls = 0;
  const client = createEnvironmentSettingsClient({
    storage: storage(),
    requestId: () => id,
    canAct: () => true,
    changed() {},
    read: async () => answer(snapshot),
    post: async () => {
      calls++;
      throw Error("lost reply");
    },
  });
  await client.check();
  client.edit("NEW");
  client.review();
  await client.save();
  const request = client.state.pending;
  if (!request) throw Error("Missing original");
  const terminal = completed(request);
  snapshot = {
    ...terminal,
    canSave: false,
    record: {
      ...terminal.record,
      last: { ...terminal.record.last!, state: "pending", finishedAt: null },
    },
  };
  await client.check();
  expect(client.state.pending).toEqual(request);
  snapshot = terminal;
  await client.check();
  expect(client.state.pending).toBeNull();
  expect(client.state.confirmed?.requestId).toBe(id);
  snapshot = {
    ...terminal,
    record: {
      ...terminal.record,
      last: { ...terminal.record.last!, state: "pending", finishedAt: null },
    },
    canSave: false,
  };
  await client.check();
  expect(client.state.fresh).toBe(false);
  expect(client.state.data?.record.last?.state).toBe("completed");
  expect(calls).toBe(1);
});

test("invalid names and unavailable intent storage never send; a held save is one flight", async () => {
  let calls = 0,
    finish = (_response: Response) => {};
  const client = createEnvironmentSettingsClient({
    storage: storage(),
    requestId: () => id,
    canAct: () => true,
    changed() {},
    read: async () => answer(ready),
    post: async () => {
      calls++;
      return new Promise<Response>((done) => {
        finish = done;
      });
    },
  });
  await client.check();
  client.edit("TOKEN=value");
  client.review();
  await client.save();
  expect(client.canReview()).toBe(false);
  expect(calls).toBe(0);
  client.edit("NEW");
  client.review();
  const saving = client.save();
  try {
    await client.save();
    client.edit("OTHER");
    client.cancel();
    expect(calls).toBe(1);
    expect(client.state.draft).toBe("NEW");
  } finally {
    finish(
      Response.json(
        { ok: false, data: null, error: "pre-effect refusal" },
        { status: 409 },
      ),
    );
  }
  await saving;
  expect(client.state.pending).toBeNull();
  expect(client.state.fresh).toBe(false);
  const unsupportedStorage = createEnvironmentSettingsClient({
    storage: null,
    requestId: () => id,
    canAct: () => true,
    changed() {},
    read: async () => answer(ready),
    post: async () => {
      calls++;
      return answer(ready);
    },
  });
  await unsupportedStorage.check();
  unsupportedStorage.edit("NEW");
  unsupportedStorage.review();
  await unsupportedStorage.save();
  expect(calls).toBe(1);
  expect(unsupportedStorage.state.storageProblem).toBe(true);
});

test("the environment view labels names-only input, target and historical receipt without exposing a values field", async () => {
  const client = createEnvironmentSettingsClient({
    storage: storage(),
    requestId: () => id,
    canAct: () => true,
    changed() {},
    read: async () => answer(ready),
    post: async () => answer(ready),
  });
  await client.check();
  client.edit("NEW");
  client.review();
  const tree = EnvironmentSettingsView({
    state: client.state,
    connected: true,
    reviewable: client.canReview(),
    saveable: client.canSave(),
    validationError: client.validationError(),
    check() {},
    edit() {},
    review() {},
    save() {},
    cancel() {},
  });
  expect(textOf(tree)).toContain("Fixed base names");
  expect(textOf(tree)).toContain("/machine/config.toml");
  expect(textOf(tree)).toContain("future");
  expect(textOf(tree)).toContain("running agents");
  expect(findAll(tree, "textarea")).toHaveLength(1);
  expect(attrs(findAll(tree, "textarea")[0])["aria-describedby"]).toBe(
    "environment-names-help",
  );
  expect(findAll(tree, "input")).toHaveLength(0);
  expect(textOf(tree)).toContain("Review before saving");
});
