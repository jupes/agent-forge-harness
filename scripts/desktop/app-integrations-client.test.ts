import { expect, test } from "bun:test";
import {
  createAppIntegrationsClient,
  type IntegrationClientDeps,
} from "../../apps/desktop/src/app-integrations-client";
import type { IntegrationPending } from "../../types/app-integrations";

const id = "11111111-1111-4111-8111-111111111111";
const scopeKey = "a".repeat(64);
const now = 1800000000000;
const ok = <T>(data: T) => ({ ok: true, data, error: null });
const ready = () =>
  ok({
    state: "review",
    client: "claude",
    requestId: id,
    scopeKey,
    expiresAt: now + 120000,
  });
const outcome = (
  state: "confirmed" | "not-attempted" | "unknown" = "confirmed",
) => ok({ state, client: "claude", requestId: id, scopeKey, reason: null });
function fixture(overrides: Partial<IntegrationClientDeps> = {}) {
  const calls: string[] = [];
  let pending: IntegrationPending | null = null;
  const deps: IntegrationClientDeps = {
    client: "claude",
    nativeAvailable: () => true,
    now: () => now,
    async review(client) {
      calls.push("review:" + client);
      return ready();
    },
    async authorize(input) {
      calls.push("authorize:" + input.requestId);
      return ok({
        schemaVersion: 1,
        requestId: input.requestId,
        client: input.client,
        authorized: true,
      });
    },
    async commit(requestId) {
      calls.push("commit:" + requestId);
      return outcome();
    },
    async recover(requestId) {
      calls.push("recover:" + requestId);
      return outcome();
    },
    pending: {
      read: () => pending,
      write(value) {
        pending = value;
      },
      clear() {
        pending = null;
      },
    },
    ...overrides,
  };
  const client = createAppIntegrationsClient(deps);
  return { client, calls, deps, pending: () => pending };
}
test("registration needs review and separate explicit confirmation before one audited native publication", async () => {
  const box = fixture();
  expect(box.calls).toEqual([]);
  await box.client.review();
  expect(box.client.state.phase).toBe("review");
  expect(box.calls).toEqual(["review:claude"]);
  await box.client.confirm();
  expect(box.calls).toEqual([
    "review:claude",
    "authorize:" + id,
    "commit:" + id,
  ]);
  expect(box.client.state.phase).toBe("configured");
  expect(box.pending()).toBeNull();
  await box.client.confirm();
  expect(box.calls).toHaveLength(3);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("lost publication response stays unknown and only exact read-only recovery resolves it", async () => {
  let commits = 0;
  const box = fixture({
    async commit() {
      commits++;
      throw Error("PRIVATE_CONFIG");
    },
  });
  await box.client.review();
  await box.client.confirm();
  expect(box.client.state.phase).toBe("unknown");
  expect(box.pending()).toEqual({
    schemaVersion: 1,
    client: "claude",
    requestId: id,
    scopeKey,
  });
  expect(JSON.stringify(box.client.state)).not.toContain("PRIVATE_CONFIG");
  await box.client.review();
  await box.client.confirm();
  expect(commits).toBe(1);
  await box.client.recover();
  expect(box.client.state.phase).toBe("configured");
  expect(box.calls).toContain("recover:" + id);
  expect(box.pending()).toBeNull();
  expect(commits).toBe(1);
});
test("reload restores metadata without an automatic native read, authorization or resend", async () => {
  const saved = { schemaVersion: 1, client: "claude", requestId: id, scopeKey };
  const box = fixture({
    pending: { read: () => saved, write() {}, clear() {} },
  });
  expect(box.client.state.phase).toBe("unknown");
  expect(box.calls).toEqual([]);
  await box.client.confirm();
  expect(box.calls).toEqual([]);
  await box.client.recover();
  expect(box.calls).toEqual(["recover:" + id]);
  expect(box.client.state.phase).toBe("configured");
});
test("source loss during recovery metadata persistence prevents the publication request", async () => {
  let client: ReturnType<typeof createAppIntegrationsClient> | undefined;
  const box = fixture({
    pending: {
      read: () => null,
      write() {
        client?.setConnected(false);
      },
      clear() {},
    },
  });
  client = box.client;
  await client.review();
  await client.confirm();
  expect(box.calls.filter((call) => call.startsWith("commit:"))).toHaveLength(
    0,
  );
  expect(client.state.phase).toBe("not-attempted");
});
test("duplicate confirmation while authorization is held sends exactly one authorization and publication", async () => {
  const held = deferred<unknown>();
  let authorizations = 0;
  const box = fixture({
    async authorize() {
      authorizations++;
      return held.promise;
    },
  });
  await box.client.review();
  const saving = box.client.confirm();
  await box.client.confirm();
  expect(authorizations).toBe(1);
  held.resolve(
    ok({ schemaVersion: 1, client: "claude", requestId: id, authorized: true }),
  );
  await saving;
  expect(box.calls.filter((call) => call.startsWith("commit:"))).toHaveLength(
    1,
  );
});
test("an expired review never reaches authorization", async () => {
  const box = fixture({ now: () => now + 120000 });
  await box.client.review();
  await box.client.confirm();
  expect(box.client.state.error).toBe("expired");
  expect(box.calls).toEqual(["review:claude"]);
});
test("authorization failure cannot become an attempted configuration write", async () => {
  const box = fixture({
    async authorize() {
      throw Error("PRIVATE_AUTH_ERROR");
    },
  });
  await box.client.review();
  await box.client.confirm();
  expect(box.client.state.phase).toBe("not-attempted");
  expect(box.client.state.error).toBe("authorization-unavailable");
  expect(box.pending()).toBeNull();
  expect(box.calls.some((call) => call.startsWith("commit:"))).toBe(false);
});
test("wrong-scope success and malformed publication responses remain unknown", async () => {
  for (const response of [
    ok({
      state: "confirmed",
      client: "claude",
      requestId: id,
      scopeKey: "b".repeat(64),
      reason: null,
    }),
    {
      ok: true,
      data: { state: "confirmed", rawConfig: "PRIVATE_CONFIG" },
      error: null,
    },
  ]) {
    const box = fixture({
      async commit() {
        return response;
      },
    });
    await box.client.review();
    await box.client.confirm();
    expect(box.client.state.phase).toBe("unknown");
    expect(box.pending()?.requestId).toBe(id);
    expect(JSON.stringify(box.client.state)).not.toContain("PRIVATE_CONFIG");
  }
});
test("unavailable recovery storage refuses before native publication", async () => {
  const box = fixture({
    pending: {
      read: () => null,
      write() {
        throw Error("blocked");
      },
      clear() {},
    },
  });
  await box.client.review();
  await box.client.confirm();
  expect(box.client.state.phase).toBe("not-attempted");
  expect(box.client.state.error).toBe("recovery-unavailable");
  expect(box.calls.some((call) => call.startsWith("commit:"))).toBe(false);
});
test("disconnect during authorization fences publication; reconnect starts no work", async () => {
  const held = deferred<unknown>();
  const box = fixture({
    async authorize() {
      return held.promise;
    },
  });
  await box.client.review();
  const saving = box.client.confirm();
  box.client.setConnected(false);
  held.resolve(
    ok({ schemaVersion: 1, client: "claude", requestId: id, authorized: true }),
  );
  await saving;
  box.client.setConnected(true);
  expect(box.calls).toEqual(["review:claude"]);
  expect(box.client.state.phase).not.toBe("configured");
});
test("disconnect and disposal after a publication request retain pending recovery metadata", async () => {
  for (const dispose of [false, true]) {
    const held = deferred<unknown>();
    const box = fixture({
      async commit() {
        return held.promise;
      },
    });
    await box.client.review();
    const saving = box.client.confirm();
    await Promise.resolve();
    await Promise.resolve();
    expect(box.pending()?.requestId).toBe(id);
    if (dispose) box.client.dispose();
    else box.client.setConnected(false);
    held.resolve(outcome());
    await saving;
    expect(box.pending()?.requestId).toBe(id);
    expect(box.client.state.phase).not.toBe("configured");
  }
});
test("a retained native pending record offers recovery without another publication", async () => {
  const box = fixture({
    async review() {
      return ok({
        state: "pending",
        client: "claude",
        requestId: id,
        scopeKey,
      });
    },
  });
  await box.client.review();
  expect(box.client.state.phase).toBe("unknown");
  await box.client.recover();
  expect(box.calls).toEqual(["recover:" + id]);
  expect(box.client.state.phase).toBe("configured");
});
test("review rejects raw config, unexpected selectors and wrong client identities", async () => {
  for (const response of [
    ok({
      state: "review",
      client: "claude",
      requestId: id,
      scopeKey,
      expiresAt: now + 120000,
      env: "PRIVATE_CONFIG",
    }),
    ok({
      state: "review",
      client: "cursor",
      requestId: id,
      scopeKey,
      expiresAt: now + 120000,
    }),
  ]) {
    const box = fixture({
      async review() {
        return response;
      },
    });
    await box.client.review();
    await box.client.confirm();
    expect(box.client.state.phase).toBe("blocked");
    expect(box.calls).toEqual([]);
    expect(JSON.stringify(box.client.state)).not.toContain("PRIVATE_CONFIG");
  }
});

test("cancel revokes a reviewed or late read without authorizing or publishing", async () => {
  const held = deferred<unknown>();
  const box = fixture({ review: () => held.promise });
  const reading = box.client.review();
  box.client.cancel();
  held.resolve(ready());
  await reading;
  await box.client.confirm();
  expect(box.client.state.phase).toBe("idle");
  expect(box.calls).toEqual([]);
});
test("connection loss from the approval observer prevents even the authorization request", async () => {
  let client: ReturnType<typeof createAppIntegrationsClient> | undefined;
  const box = fixture({
    changed() {
      if (client?.state.phase === "authorizing") client.setConnected(false);
    },
  });
  client = box.client;
  await client.review();
  await client.confirm();
  expect(box.calls).toEqual(["review:claude"]);
});
