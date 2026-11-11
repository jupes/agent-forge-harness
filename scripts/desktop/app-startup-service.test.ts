import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { ensurePrivateHome } from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import type {
  StartupBackend,
  StartupRegistration,
} from "./app-startup-protocol";
import {
  AppStartupError,
  createAppStartupService,
} from "./app-startup-service";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("forge-startup-")
    )
      throw Error("Unexpected fixture path");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const profile = mkdtempSync(join(tmpdir(), "forge-startup-"));
  roots.push(profile);
  const coordinationHome = join(profile, ".agent-forge-startup-v1");
  let registration: StartupRegistration = "disabled",
    calls = 0;
  const backend: StartupBackend = {
    read: async () => ({
      installationKey: "a".repeat(64),
      coordinationHome,
      registration,
    }),
    set: async (enabled) => {
      calls++;
      registration = enabled ? "enabled" : "disabled";
      return {
        outcome: "completed",
        observation: await backend.read(new AbortController().signal),
      };
    },
  };
  return { backend, coordinationHome, calls: () => calls };
}
const request = {
  requestId: "ad000000-0000-4000-8000-000000000001",
  installationKey: "a".repeat(64),
  expectedRevision: 0,
  expectedFingerprint: "absent",
  enabled: true,
};
test("startup explicit save verifies durable global intent before native effect and retains exact completion across hosts", async () => {
  const f = fixture(),
    original = f.backend.set;
  f.backend.set = async (...args) => {
    expect(
      existsSync(join(f.coordinationHome, "startup-registration.json")),
    ).toBe(true);
    return original(...args);
  };
  const service = createAppStartupService({ backend: f.backend });
  expect(existsSync(f.coordinationHome)).toBe(false);
  expect(await service.read()).toMatchObject({
    capability: "available",
    registration: "disabled",
    record: { revision: 0 },
  });
  expect(existsSync(f.coordinationHome)).toBe(false);
  const result = await service.write(request);
  expect(result).toMatchObject({
    capability: "available",
    registration: "enabled",
    record: { revision: 1, last: { state: "completed", request } },
  });
  expect(f.calls()).toBe(1);
  expect(
    await createAppStartupService({ backend: f.backend }).read(),
  ).toMatchObject({ record: { revision: 1, last: { state: "completed" } } });
  await service.close();
});
test("pending uncertainty blocks another host or installation using the same OS-user journal", async () => {
  const f = fixture();
  f.backend.set = async () => ({ outcome: "unconfirmed", observation: null });
  const first = createAppStartupService({ backend: f.backend });
  await expect(first.write(request)).rejects.toMatchObject({ status: 504 });
  let foreignWrites = 0;
  const other: StartupBackend = {
    read: async (signal) => ({
      ...(await f.backend.read(signal)),
      installationKey: "b".repeat(64),
    }),
    set: async () => {
      foreignWrites++;
      throw Error("MUST_NOT_RUN");
    },
  };
  const second = createAppStartupService({ backend: other });
  expect(await second.read()).toMatchObject({
    canSave: false,
    record: { revision: 1, last: { state: "pending", request } },
  });
  await expect(
    second.write({
      ...request,
      expectedRevision: 1,
      installationKey: "b".repeat(64),
      requestId: "ad000000-0000-4000-8000-000000000002",
    }),
  ).rejects.toMatchObject({ status: 504 });
  expect(foreignWrites).toBe(0);
  await first.close();
  await second.close();
});
test("same-revision concurrent writers serialize and stale installation or fingerprint never reaches native set", async () => {
  const f = fixture(),
    a = createAppStartupService({ backend: f.backend }),
    b = createAppStartupService({ backend: f.backend });
  for (const bad of [
    { ...request, installationKey: "b".repeat(64) },
    { ...request, expectedFingerprint: "a".repeat(64) },
  ])
    await expect(a.write(bad)).rejects.toMatchObject({ status: 409 });
  expect(f.calls()).toBe(0);
  const result = await Promise.allSettled([
    a.write(request),
    b.write({ ...request, requestId: "ad000000-0000-4000-8000-000000000003" }),
  ]);
  expect(result.filter((value) => value.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(f.calls()).toBe(1);
  await a.close();
  await b.close();
});
test("completed publication followed by a thrown error stays unknown to POST but exact completion can be inspected after recreation", async () => {
  const f = fixture();
  const service = createAppStartupService({
    backend: f.backend,
    write(file, text) {
      writeOwnerOnly(file, text);
      if (text.includes('"state":"completed"'))
        throw Error("PRIVATE_POST_PUBLICATION");
    },
  });
  await expect(service.write(request)).rejects.toMatchObject({ status: 504 });
  expect(await service.read()).toMatchObject({
    registration: "enabled",
    canSave: false,
    record: { last: { state: "completed", request } },
  });
  const fresh = createAppStartupService({ backend: f.backend });
  expect(await fresh.read()).toMatchObject({
    canSave: true,
    record: { last: { state: "completed", request } },
  });
  expect(f.calls()).toBe(1);
  await service.close();
  await fresh.close();
});
test("only a published explicit native refusal can return409 after intent; current state never synthesizes completion", async () => {
  const f = fixture(),
    service = createAppStartupService({ backend: f.backend });
  f.backend.set = async () => ({
    outcome: "refused",
    observation: await f.backend.read(new AbortController().signal),
  });
  await expect(service.write(request)).rejects.toMatchObject({ status: 409 });
  expect(await service.read()).toMatchObject({
    canSave: true,
    record: { last: { state: "refused" } },
  });
  await service.close();
});
test("corrupt, missing initialized, oversized history and uncertain first marker publication never auto-reset", async () => {
  for (const content of [null, "{broken", "x".repeat(4097)]) {
    const f = fixture();
    writeOwnerOnly(
      join(f.coordinationHome, "startup-registration.initialized"),
      "app-startup-v1\n",
    );
    if (content !== null)
      writeOwnerOnly(
        join(f.coordinationHome, "startup-registration.json"),
        content,
      );
    const service = createAppStartupService({ backend: f.backend });
    await expect(service.read()).rejects.toMatchObject({ status: 503 });
    await expect(service.write(request)).rejects.toMatchObject({ status: 503 });
    expect(f.calls()).toBe(0);
    await service.close();
  }
  const f = fixture(),
    service = createAppStartupService({
      backend: f.backend,
      write() {
        throw Error("PRIVATE_MARKER");
      },
    });
  await expect(service.write(request)).rejects.toMatchObject({ status: 504 });
  expect(await service.read()).toMatchObject({ canSave: false });
  await expect(service.write(request)).rejects.toMatchObject({ status: 504 });
  expect(f.calls()).toBe(0);
  await service.close();
});
test("close aborts and joins a pending helper, leaves durable uncertainty and prevents all late writes", async () => {
  const f = fixture();
  let entered = () => {},
    release = (_result: Awaited<ReturnType<StartupBackend["set"]>>) => {};
  const saw: AbortSignal[] = [];
  const started = new Promise<void>((done) => {
    entered = done;
  });
  f.backend.set = async (_enabled, _expected, signal) => {
    saw.push(signal);
    entered();
    return new Promise((done) => {
      release = done;
    });
  };
  const service = createAppStartupService({ backend: f.backend });
  const action = service.write(request).catch((error) => error);
  await started;
  let finished = false;
  const closing = service.close().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(saw[0]?.aborted).toBe(true);
  release({ outcome: "unconfirmed", observation: null });
  expect(await action).toMatchObject({ status: 504 });
  await closing;
  await expect(service.write(request)).rejects.toMatchObject({ status: 503 });
  const fresh = createAppStartupService({ backend: f.backend });
  expect(await fresh.read()).toMatchObject({
    canSave: false,
    record: { last: { state: "pending" } },
  });
  await fresh.close();
});
test("a native error labelled409 after a possible write remains unknown, never a pre-effect refusal", async () => {
  const f = fixture(),
    set = f.backend.set;
  f.backend.set = async (...args) => {
    await set(...args);
    throw new AppStartupError(409, "PRIVATE_AFTER_WRITE");
  };
  const service = createAppStartupService({ backend: f.backend });
  await expect(service.write(request)).rejects.toMatchObject({ status: 504 });
  expect(await service.read()).toMatchObject({
    canSave: false,
    record: { last: { state: "pending" } },
  });
  await service.close();
});
test("close during the locked status recheck cannot publish a new pending journal", async () => {
  const f = fixture(),
    read = f.backend.read;
  let calls = 0,
    entered = () => {},
    release = () => {};
  const held = new Promise<void>((done) => {
      release = done;
    }),
    started = new Promise<void>((done) => {
      entered = done;
    });
  f.backend.read = async (signal) => {
    if (++calls === 2) {
      entered();
      await held;
    }
    return read(signal);
  };
  const service = createAppStartupService({ backend: f.backend }),
    result = service.write(request).catch((error) => error);
  await started;
  const closing = service.close();
  release();
  expect(await result).toMatchObject({ status: 503 });
  await closing;
  expect(
    existsSync(join(f.coordinationHome, "startup-registration.json")),
  ).toBe(false);
  expect(
    existsSync(join(f.coordinationHome, "startup-registration.initialized")),
  ).toBe(false);
  expect(f.calls()).toBe(0);
});
test("close joins a queued full write until its cooperating mutex is released", async () => {
  const f = fixture();
  ensurePrivateHome(f.coordinationHome);
  let unlock = () => {},
    entered = () => {},
    queried = () => {};
  const held = new Promise<void>((done) => {
      entered = done;
    }),
    read = new Promise<void>((done) => {
      queried = done;
    });
  const locked = withQueueLock(
    join(f.coordinationHome, "startup-registration.lock"),
    async () => {
      entered();
      await new Promise<void>((done) => {
        unlock = done;
      });
    },
  );
  await held;
  const original = f.backend.read;
  f.backend.read = async (signal) => {
    const value = await original(signal);
    queried();
    return value;
  };
  const service = createAppStartupService({ backend: f.backend }),
    action = service.write(request).catch((error) => error);
  await read;
  await Promise.resolve();
  await Promise.resolve();
  const closing = service.close();
  const closedBeforeRelease = await Promise.race([
    closing.then(() => true),
    new Promise<boolean>((done) => setTimeout(() => done(false), 0)),
  ]);
  unlock();
  await locked;
  const outcome = await action;
  await closing;
  expect(closedBeforeRelease).toBe(false);
  expect(outcome).toMatchObject({ status: 503 });
  expect(
    existsSync(join(f.coordinationHome, "startup-registration.json")),
  ).toBe(false);
});
