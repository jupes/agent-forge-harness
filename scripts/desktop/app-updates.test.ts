import { expect, test } from "bun:test";
import { version } from "../../package.json";
import { startTestHearth, type TestHearth } from "../hearth/testing";

test("update checks are explicit, protected, strictly validated and audited before the metadata effect", async () => {
  let calls = 0,
    h: TestHearth | null = null;
  const fixture = await startTestHearth({
    api: {
      appUpdateCheck: async () => {
        calls++;
        expect(h?.events(["operator.action"]).at(-1)?.payload).toMatchObject({
          action: "app.updates.check",
          target: "app-updates",
        });
        return {
          state: "unavailable",
          reason: "not-found",
          currentVersion: version,
          checkedAt: "2026-11-10T00:00:00Z",
        };
      },
    },
  });
  h = fixture;
  const post = (
    path: string,
    body: unknown,
    token: string | null = fixture.hearth.token,
  ) =>
    fetch(fixture.api + path, {
      method: "POST",
      headers: fixture.headers(token),
      body: JSON.stringify(body),
    });
  try {
    expect(calls).toBe(0);
    for (const token of [null, "wrong"])
      expect(
        (await post("/app-settings/updates/check", {}, token)).status,
      ).toBe(403);
    expect(
      (await post("/app-settings/updates/check?url=https://evil.example", {}))
        .status,
    ).toBe(400);
    expect(
      (
        await post("/app-settings/updates/check", {
          url: "https://evil.example",
        })
      ).status,
    ).toBe(400);
    expect(calls).toBe(0);
    expect((await post("/app-settings/updates/check", {})).status).toBe(200);
    expect(calls).toBe(1);
    expect(fixture.bd.calls).toEqual([]);
  } finally {
    await fixture.close();
  }
  const blocked = await startTestHearth({
    api: {
      appendEvent: () => ({ ok: false, error: "fixture audit refusal" }),
      appUpdateCheck: async () => {
        throw Error("Effect must not run");
      },
    },
  });
  try {
    expect(
      (
        await fetch(blocked.api + "/app-settings/updates/check", {
          method: "POST",
          headers: blocked.headers(blocked.hearth.token),
          body: "{}",
        })
      ).status,
    ).toBe(503);
  } finally {
    await blocked.close();
  }
});
