import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createHearthRuntimeLog } from "../hearth/runtime-log";
import { startTestHearth } from "../hearth/testing";
import { hearthLogSnapshotSchema } from "./app-hearth-log-protocol";

async function snapshot(response: Response) {
  const raw: unknown = await response.json();
  if (
    !raw ||
    typeof raw !== "object" ||
    !("ok" in raw) ||
    raw.ok !== true ||
    !("data" in raw)
  )
    throw Error("Missing log envelope");
  return hearthLogSnapshotSchema.parse(raw.data);
}
function getWithBody(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: "GET", headers: { ...headers, "content-length": "2" } },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      },
    );
    request.setTimeout(2000, () =>
      request.destroy(Error("Fixture request timed out")),
    );
    request.once("error", reject);
    request.end("{}");
  });
}
test("service log is protected before read and rejects selectors, bodies and mutation methods", async () => {
  let reads = 0;
  const log = createHearthRuntimeLog(),
    h = await startTestHearth({
      api: {
        readHearthLog() {
          reads++;
          return log.read();
        },
      },
    });
  try {
    const path = `${h.api}/app-settings/hearth/logs`;
    for (const token of [null, "wrong-token"])
      expect((await fetch(path, { headers: h.headers(token) })).status).toBe(
        403,
      );
    expect(reads).toBe(0);
    expect(
      (
        await fetch(path + "?file=foreign.log", {
          headers: h.headers(h.hearth.token),
        })
      ).status,
    ).toBe(400);
    expect(await getWithBody(path, h.headers(h.hearth.token))).toBe(400);
    expect(
      (
        await fetch(path, {
          method: "POST",
          headers: h.headers(h.hearth.token),
          body: "{}",
        })
      ).status,
    ).toBe(405);
    expect(reads).toBe(0);
    expect(
      (
        await snapshot(
          await fetch(path, { headers: h.headers(h.hearth.token) }),
        )
      ).entries,
    ).toEqual([]);
    expect(reads).toBe(1);
    expect(h.events()).toEqual([]);
  } finally {
    await h.close();
  }
});

test("actual current Hearth records owned readiness and audit appends while reads remain inert", async () => {
  const h = await startTestHearth();
  try {
    const path = `${h.api}/app-settings/hearth/logs`,
      existed = existsSync(h.ledger),
      read = () => fetch(path, { headers: h.headers(h.hearth.token) });
    const before = await snapshot(await read()),
      again = await snapshot(await read());
    expect(before.entries.map((entry) => entry.code)).toEqual([
      "runtime.created",
      "runtime.listening",
    ]);
    expect(again.latestSequence).toBe(before.latestSequence);
    expect(again.generation).toBe(before.generation);
    expect(existsSync(h.ledger)).toBe(existed);
    const response = await fetch(`${h.api}/app-settings/updates/check`, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: "{}",
    });
    expect(response.status).toBe(200);
    await response.body?.cancel();
    const after = await snapshot(await read());
    expect(after.entries.at(-1)).toMatchObject({
      code: "ledger.inserted",
      eventKind: "operator.action",
    });
    expect(after.latestSequence).toBe(before.latestSequence + 1);
    expect(JSON.stringify(after)).not.toContain("app-updates");
    expect(h.events(["operator.action"])).toHaveLength(1);
  } finally {
    await h.close();
  }
});

test("unconfirmed audit logs retain no raw error and cannot let an effect run", async () => {
  let calls = 0;
  const h = await startTestHearth({
    api: {
      appendEvent: () => ({ ok: false, error: "PRIVATE_DIAGNOSTIC_VALUE" }),
      appUpdateCheck: async () => {
        calls++;
        throw Error("Effect must not run");
      },
    },
  });
  try {
    const response = await fetch(`${h.api}/app-settings/updates/check`, {
      method: "POST",
      headers: h.headers(h.hearth.token),
      body: "{}",
    });
    expect(response.status).toBe(503);
    await response.body?.cancel();
    expect(calls).toBe(0);
    const data = await snapshot(
      await fetch(`${h.api}/app-settings/hearth/logs`, {
        headers: h.headers(h.hearth.token),
      }),
    );
    expect(data.entries.at(-1)).toMatchObject({
      code: "ledger.failed",
      level: "warning",
      eventKind: "operator.action",
    });
    expect(JSON.stringify(data)).not.toContain("PRIVATE_DIAGNOSTIC_VALUE");
    expect(h.events()).toEqual([]);
  } finally {
    await h.close();
  }
});

test("inconsistent empty history is unavailable at the protected wire boundary", async () => {
  const empty = createHearthRuntimeLog().read(),
    h = await startTestHearth({
      api: {
        readHearthLog: () => ({
          ...empty,
          latestSequence: 10,
          retainedCount: 0,
          evictedCount: 10,
          entries: [],
          omittedRetainedCount: 0,
        }),
      },
    });
  try {
    const response = await fetch(`${h.api}/app-settings/hearth/logs`, {
      headers: h.headers(h.hearth.token),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('"entries":[]');
  } finally {
    await h.close();
  }
});
