import { afterEach, expect, test } from "bun:test";
import { createAppNotificationStore } from "../../projects/app-notifications-store";
import { startTestHearth, type TestHearth } from "../testing";

const opened: TestHearth[] = [];
afterEach(async () => {
  for (const h of opened.splice(0)) await h.close();
});
test("actual protected app notification API audits before CAS effect and preserves conflicts", async () => {
  const h = await startTestHearth();
  opened.push(h);
  const path = h.api + "/app-settings/notifications";
  expect((await fetch(path, { headers: h.headers(null) })).status).toBe(403);
  const fresh = await fetch(path, { headers: h.headers(h.hearth.token) });
  expect(fresh.status).toBe(200);
  expect((await fresh.json()).data).toMatchObject({
    revision: 0,
    source: "default",
    policy: { enabled: true, quietHours: null },
  });
  const post = (body: unknown) =>
    fetch(path, {
      method: "POST",
      headers: {
        ...h.headers(h.hearth.token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  expect(
    (
      await post({
        expectedRevision: 0,
        policy: { enabled: false, quietHours: null },
      })
    ).status,
  ).toBe(200);
  const audit = h
    .events(["operator.action"])
    .filter(
      (event) =>
        event.kind === "operator.action" &&
        event.payload.action === "app.settings.notifications",
    );
  expect(audit).toHaveLength(1);
  expect(createAppNotificationStore(h.home).read()).toMatchObject({
    revision: 1,
    policy: { enabled: false, quietHours: null },
  });
  expect(
    (
      await post({
        expectedRevision: 0,
        policy: { enabled: true, quietHours: null },
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await post({
        expectedRevision: 1,
        policy: { enabled: true, quietHours: { startMinute: 0, endMinute: 0 } },
      })
    ).status,
  ).toBe(400);
  expect(createAppNotificationStore(h.home).read().policy.enabled).toBe(false);
  expect(h.bd.calls.filter((call) => call.includes("update"))).toHaveLength(0);
});
