import { expect, test } from "bun:test";
import { createSmithVerificationClient } from "../../apps/desktop/src/smith-verification-client";
import { APPRENTICE_VERIFICATION } from "../smith-verification";

const workspace = "/served/workspace";
function record(title = "Owner verification remains pending") {
  return {
    workspace,
    checkedAt: "2026-10-23T00:00:00Z",
    task: {
      id: APPRENTICE_VERIFICATION,
      title,
      status: "open",
      priority: 0,
      description: "<script>inert</script>",
      acceptanceCriteria: "Record the actual result",
      notes: "No capability claim",
      updatedAt: null,
    },
  };
}
test("verification opens only on explicit request and closes or disposes without accepting a late read", async () => {
  const resolvers: ((value: unknown) => void)[] = [];
  const signals: AbortSignal[] = [];
  const client = createSmithVerificationClient({
    workspace,
    read: (signal) => {
      signals.push(signal);
      return new Promise((resolve) => resolvers.push(resolve));
    },
  });
  expect(signals).toHaveLength(0);
  const old = client.open();
  expect(client.get()).toMatchObject({ open: true, loading: true, data: null });
  await client.refresh();
  expect(signals).toHaveLength(1);
  client.close();
  expect(signals[0]?.aborted).toBe(true);
  const current = client.open();
  resolvers[0]?.(record("Old answer"));
  await old;
  expect(client.get().data).toBeNull();
  resolvers[1]?.(record("Current answer"));
  await current;
  expect(client.get().data?.task.title).toBe("Current answer");
  client.close();
  const pending = client.open();
  client.dispose();
  resolvers[2]?.(record("After disposal"));
  await pending;
  expect(client.get()).toMatchObject({
    open: false,
    loading: false,
    data: null,
  });
});

test("verification refuses another served workspace or fixed identity and can explicitly retry a failed read", async () => {
  let answer: unknown = { ...record(), workspace: "/foreign" };
  let calls = 0;
  const client = createSmithVerificationClient({
    workspace,
    read: async () => {
      calls++;
      return answer;
    },
  });
  await client.open();
  expect(client.get().data).toBeNull();
  expect(client.get().error).toContain("could not be verified");
  answer = { ...record(), task: { ...record().task, id: "foreign-id" } };
  await client.refresh();
  expect(client.get().data).toBeNull();
  answer = record();
  await client.refresh();
  expect(client.get()).toMatchObject({
    loading: false,
    error: "",
    data: record(),
  });
  expect(calls).toBe(3);
  client.dispose();
});

test("verification keeps earlier facts labelled stale after a bounded read deadline and cancels its transport", async () => {
  let expire: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  let reads = 0,
    cleared = 0;
  const client = createSmithVerificationClient({
    workspace,
    read: async (current) => {
      signal = current;
      return ++reads === 1 ? record() : new Promise<never>(() => {});
    },
    timers: {
      set(run) {
        expire = run;
        return run;
      },
      clear() {
        cleared++;
      },
    },
  });
  await client.open();
  const pending = client.refresh();
  expire?.();
  await pending;
  expect(signal?.aborted).toBe(true);
  expect(client.get()).toMatchObject({
    open: true,
    loading: false,
    data: record(),
    error: expect.stringContaining("45 seconds"),
  });
  expect(cleared).toBe(2);
  client.dispose();
});
