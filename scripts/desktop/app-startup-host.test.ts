import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDesktopHost } from "../hearth/desktop-host";
import { startTestHearth } from "../hearth/testing";
import type {
  StartupBackend,
  StartupRegistration,
} from "./app-startup-protocol";

const request = {
  requestId: "ae000000-0000-4000-8000-000000000001",
  installationKey: "a".repeat(64),
  expectedRevision: 0,
  expectedFingerprint: "absent",
  enabled: true,
};
async function fixture() {
  const hearth = await startTestHearth();
  const assetsRoot = join(hearth.root, "startup-test-assets");
  mkdirSync(assetsRoot);
  writeFileSync(join(assetsRoot, "index.html"), "headless startup fixture");
  const coordinationHome = join(hearth.root, "fake-os-user-startup");
  let registration: StartupRegistration = "disabled",
    writes = 0,
    reads = 0;
  const backend: StartupBackend = {
    read: async () => {
      reads++;
      return {
        installationKey: request.installationKey,
        coordinationHome,
        registration,
      };
    },
    set: async (enabled) => {
      expect(hearth.events(["operator.action"]).at(-1)?.payload).toMatchObject({
        action: "desktop.startup.set",
        target: request.requestId,
      });
      expect(
        existsSync(join(coordinationHome, "startup-registration.json")),
      ).toBe(true);
      writes++;
      registration = enabled ? "enabled" : "disabled";
      return {
        outcome: "completed",
        observation: await backend.read(new AbortController().signal),
      };
    },
  };
  try {
    const host = await startDesktopHost({
      root: hearth.root,
      assetsRoot,
      home: hearth.home,
      startupBackend: backend,
      supervisor: {
        ensure: async () => hearth.hearth.port,
        stopIfOwner: async () => {},
      },
    });
    const origin = new URL(host.url).origin;
    const headers = (token: string | null = hearth.hearth.token) => ({
      ...hearth.headers(token),
      Origin: origin,
    });
    return {
      hearth,
      host,
      coordinationHome,
      headers,
      url: origin + "/__agent-forge/desktop/startup",
      writes: () => writes,
      reads: () => reads,
      close: async () => {
        await host.close();
        await hearth.close();
      },
    };
  } catch (error) {
    await hearth.close();
    throw error;
  }
}
test("desktop startup rows protect reads and writes, reject paths/queries/duplicates and audit before native registration", async () => {
  const f = await fixture();
  const post = (
    body: unknown,
    token: string | null = f.hearth.hearth.token,
    query = "",
  ) =>
    fetch(f.url + query, {
      method: "POST",
      headers: f.headers(token),
      body: JSON.stringify(body),
    });
  try {
    for (const token of [null, "wrong"]) {
      expect((await fetch(f.url, { headers: f.headers(token) })).status).toBe(
        403,
      );
      expect((await post(request, token)).status).toBe(403);
    }
    expect((await post({ ...request, command: "other" })).status).toBe(400);
    expect(
      (await post(request, f.hearth.hearth.token, "?path=other")).status,
    ).toBe(400);
    const duplicate =
      JSON.stringify(request).slice(0, -1) + ',"enabled":false}';
    expect(
      (
        await fetch(f.url, {
          method: "POST",
          headers: f.headers(),
          body: duplicate,
        })
      ).status,
    ).toBe(400);
    expect(f.reads()).toBe(0);
    expect(f.writes()).toBe(0);
    expect(existsSync(f.coordinationHome)).toBe(false);
    expect((await post(request)).status).toBe(200);
    expect(f.writes()).toBe(1);
    expect((await post(request)).status).toBe(409);
    expect(f.writes()).toBe(1);
    expect(f.hearth.bd.calls).toEqual([]);
  } finally {
    await f.close();
  }
});
test("desktop startup audit refusal never reaches the native backend or creates global intent", async () => {
  const f = await fixture();
  f.hearth.append({
    kind: "operator.action",
    payload: { action: "fixture", surface: "ui" },
  });
  const db = new Database(f.hearth.ledger);
  try {
    db.exec("BEGIN IMMEDIATE");
    const response = await fetch(f.url, {
      method: "POST",
      headers: f.headers(),
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(503);
    expect(f.reads()).toBe(0);
    expect(f.writes()).toBe(0);
    expect(existsSync(f.coordinationHome)).toBe(false);
  } finally {
    db.exec("ROLLBACK");
    db.close();
    await f.close();
  }
});
