import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createSmithsClient } from "../../apps/desktop/src/smiths-client";
import { readSmithsResponse } from "../../apps/desktop/src/smiths-response";
import { loadConfig } from "../config/load";

const empty = { rows: [], events: 0, from: null, to: null };
const at = Date.parse("2026-10-23T12:00:00.000Z");
function configuration() {
  const config = loadConfig({
    harnessRoot: resolve("/workspace"),
    home: resolve("/machine"),
    env: {},
  });
  return {
    config,
    smiths: {
      smiths: Object.values(config.config.smiths),
      benches: config.config.benches,
      defaultSmith: config.config.workflow.defaultCrew,
    },
  };
}
function held<T>() {
  let done: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    done = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!done) throw Error("Deferred reader missing");
      done(value);
    },
  };
}

test("a new scoreboard range wins a late old reply without replacing its original range label", async () => {
  const old = held<unknown>();
  const calls: (string | null)[] = [];
  const client = createSmithsClient({
    now: () => at,
    configuration: async () => configuration(),
    scoreboard: async (since) => {
      calls.push(since);
      return calls.length === 1 ? old.promise : empty;
    },
  });
  const pending = client.refreshScoreboard();
  await client.setRange("24h");
  expect(calls).toEqual([
    "2026-10-16T12:00:00.000Z",
    "2026-10-22T12:00:00.000Z",
  ]);
  old.resolve({ invalid: "old range" });
  await pending;
  expect(client.get().scoreboard).toMatchObject({
    data: empty,
    error: "",
    loading: false,
  });
  expect(client.get().scoreboardRange).toBe("24h");
  client.dispose();
});

test("independent reads retain verified stale values and refuse changed configuration correlation", async () => {
  let badBoard = false,
    badConfig = false;
  const client = createSmithsClient({
    now: () => at,
    configuration: async () => {
      const value = configuration();
      if (badConfig) value.smiths.defaultSmith = "claude-master";
      return value;
    },
    scoreboard: async () => {
      if (badBoard) throw Error("Fixture scoreboard unavailable");
      return empty;
    },
  });
  await Promise.all([
    client.refreshConfiguration(),
    client.refreshScoreboard(),
  ]);
  expect(client.get().configuration.data?.smiths.length).toBeGreaterThan(0);
  badBoard = true;
  await client.refreshScoreboard();
  expect(client.get().scoreboard).toMatchObject({
    data: empty,
    error: "Fixture scoreboard unavailable",
  });
  expect(client.get().configuration.error).toBe("");
  badConfig = true;
  await client.refreshConfiguration();
  expect(client.get().configuration.error).not.toBe("");
  expect(client.get().configuration.data?.defaultSmith).toBe(
    "claude-journeyman",
  );
  badBoard = false;
  await client.refreshScoreboard();
  expect(client.get().scoreboard.error).toBe("");
  expect(client.get().configuration.error).not.toBe("");
  client.dispose();
});

test("a held resync keeps the earlier error while loading, then an explicit settled read is a separate request", async () => {
  const resync = held<ReturnType<typeof configuration>>();
  let configurationReads = 0;
  const client = createSmithsClient({
    now: () => at,
    configuration: async () => {
      configurationReads++;
      if (configurationReads === 1)
        return { config: { malformed: true }, smiths: {} };
      return configurationReads === 2 ? resync.promise : configuration();
    },
    scoreboard: async () => empty,
  });
  await client.refreshConfiguration();
  const earlierError = client.get().configuration.error;
  expect(earlierError).toContain("could not be verified");
  expect(client.get().configuration).toMatchObject({
    data: null,
    loading: false,
  });
  const settled = new Promise<void>((resolve) => {
    client.subscribe(() => {
      const state = client.get().configuration;
      if (!state.loading && state.data) resolve();
    });
  });
  client.changed();
  expect(client.get().configuration).toMatchObject({
    data: null,
    loading: true,
    error: earlierError,
  });
  resync.resolve(configuration());
  await settled;
  expect(client.get().configuration).toMatchObject({
    loading: false,
    error: "",
  });
  expect(client.get().configuration.data?.defaultSmith).toBe(
    "claude-journeyman",
  );
  expect(configurationReads).toBe(2);
  await client.refreshConfiguration();
  expect(configurationReads).toBe(3);
  expect(client.get().configuration).toMatchObject({
    loading: false,
    error: "",
  });
  client.dispose();
});

test("closing an observer fences its late reply and a never-ending read has a bounded failure", async () => {
  const later = held<unknown>();
  let expire: (() => void) | undefined;
  const client = createSmithsClient({
    configuration: async () => configuration(),
    scoreboard: async () => later.promise,
    timers: {
      set(run) {
        expire = run;
        return run;
      },
      clear() {},
    },
  });
  const pending = client.refreshScoreboard();
  expire?.();
  await pending;
  expect(client.get().scoreboard.loading).toBe(false);
  expect(client.get().scoreboard.error).toContain("did not finish");
  let paints = 0;
  client.subscribe(() => paints++);
  client.dispose();
  later.resolve(empty);
  await Promise.resolve();
  expect(paints).toBe(0);
  expect(client.get().scoreboard.data).toBeNull();
});

test("Smiths reads reject incomplete, failed, malformed UTF-8 and oversized envelopes", async () => {
  expect(
    await readSmithsResponse(
      new Response(JSON.stringify({ ok: true, data: empty, error: null })),
    ),
  ).toEqual(empty);
  for (const text of [
    "bad json",
    JSON.stringify({ ok: true, data: {}, error: "not success" }),
    JSON.stringify({ ok: true, error: null }),
    JSON.stringify({ ok: true, data: {}, error: null, extra: true }),
    "x".repeat(2 * 1024 * 1024 + 1025),
  ])
    await expect(readSmithsResponse(new Response(text))).rejects.toThrow();
  await expect(
    readSmithsResponse(new Response(new Uint8Array([0xff]))),
  ).rejects.toThrow();
});
