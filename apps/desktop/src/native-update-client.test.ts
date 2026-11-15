import { expect, test } from "bun:test";
import type {
  NativeUpdatePending,
  NativeUpdateResult,
} from "../../../types/native-update";
import {
  createNativeUpdateClient,
  type NativeUpdateDependencies,
} from "./native-update-client";

const id = "ad000000-0000-4000-8000-000000000001",
  scopeKey = "a".repeat(64);
const wire = (data: unknown) => ({ ok: true, data, error: null });
function fixture() {
  const trace: string[] = [],
    currentVersion = "1.0.0-rc.1";
  let pending: NativeUpdatePending | null = null;
  let nativeState: NativeUpdateResult["state"] = "available";
  const result = (): NativeUpdateResult => ({
    schemaVersion: 1,
    currentVersion,
    scopeKey,
    requestId: id,
    version: "1.0.0",
    state: nativeState,
  });
  const deps: NativeUpdateDependencies = {
    currentVersion,
    connected: () => true,
    newId: () => id,
    changed() {},
    native: async (request) => {
      trace.push("native:" + request.operation);
      if (request.operation === "download") nativeState = "downloaded";
      if (request.operation === "install") nativeState = "install-unknown";
      return wire(result());
    },
    authorize: async (request) => {
      trace.push("audit:" + request.operation);
      return wire({ ...request, schemaVersion: 1, authorized: true });
    },
    storage: {
      load: () => pending,
      save: (value) => {
        trace.push(value ? "persist" : "clear");
        pending = value;
      },
    },
  };
  const client = createNativeUpdateClient(deps);
  return { client, deps, trace, pending: () => pending };
}
test("native update check and download never install; only separately confirmed persisted intent reaches an audited install", async () => {
  const f = fixture();
  expect(f.trace).toEqual([]);
  await f.client.check();
  expect(f.client.state.result?.state).toBe("available");
  await f.client.download();
  expect(f.client.state.result?.state).toBe("downloaded");
  expect(f.trace).toEqual([
    "audit:check",
    "native:check",
    "audit:download",
    "native:download",
  ]);
  f.client.review();
  expect(f.client.state.review).toBe(true);
  f.client.cancel();
  expect(f.pending()).toBeNull();
  f.client.review();
  await f.client.confirm();
  expect(f.trace.slice(-3)).toEqual([
    "persist",
    "audit:install",
    "native:install",
  ]);
  expect(f.client.state.unknown).toBe(true);
  expect(f.pending()?.requestId).toBe(id);
  await f.client.confirm();
  expect(f.trace.filter((x) => x === "native:install")).toHaveLength(1);
});

test("a different target version cannot replace the persisted original installation intent", async () => {
  const f = fixture();
  await f.client.check();
  await f.client.download();
  f.client.review();
  f.deps.native = async (request) => {
    f.trace.push("native:" + request.operation);
    return wire({
      schemaVersion: 1,
      currentVersion: f.deps.currentVersion,
      scopeKey,
      requestId: id,
      version: "9.0.0",
      state: "install-unknown",
    });
  };
  await f.client.confirm();
  expect(f.client.state.unknown).toBe(true);
  expect(f.client.state.result?.version).toBe("1.0.0");
  expect(f.client.state.error).not.toBeNull();
  expect(f.pending()?.version).toBe("1.0.0");
});
test("lost install reply survives a fresh client and permits only exact read-only outcome recovery", async () => {
  const f = fixture();
  await f.client.check();
  await f.client.download();
  f.client.review();
  f.deps.native = async (request) => {
    f.trace.push("native:" + request.operation);
    throw Error("lost reply");
  };
  await f.client.confirm();
  expect(f.client.state.unknown).toBe(true);
  f.client.dispose();
  const reloaded = createNativeUpdateClient(f.deps);
  expect(reloaded.state.unknown).toBe(true);
  await reloaded.check();
  await reloaded.download();
  await reloaded.confirm();
  expect(f.trace.filter((x) => x === "native:install")).toHaveLength(1);
  f.deps.native = async (request) => {
    expect(request).toEqual({ operation: "status", requestId: id });
    f.trace.push("native:status");
    return wire({
      schemaVersion: 1,
      currentVersion: f.deps.currentVersion,
      scopeKey,
      requestId: id,
      version: "1.0.0",
      state: "install-unknown",
    });
  };
  await reloaded.refresh();
  expect(reloaded.state.unknown).toBe(true);
  expect(f.pending()?.requestId).toBe(id);
  f.deps.native = async () =>
    wire({
      schemaVersion: 1,
      currentVersion: f.deps.currentVersion,
      scopeKey,
      requestId: id,
      version: null,
      state: "not-attempted",
    });
  await reloaded.refresh();
  expect(reloaded.state.unknown).toBe(false);
  expect(f.pending()).toBeNull();
});
test("failed intent persistence and mismatched audit authorization cannot send an install", async () => {
  for (const mode of ["storage", "audit"]) {
    const f = fixture();
    await f.client.check();
    await f.client.download();
    f.client.review();
    if (mode === "storage")
      f.deps.storage.save = () => {
        throw Error("unavailable");
      };
    else
      f.deps.authorize = async () =>
        wire({
          schemaVersion: 1,
          authorized: true,
          operation: "install",
          requestId: "ad000000-0000-4000-8000-000000000002",
        });
    await f.client.confirm();
    expect(f.trace).not.toContain("native:install");
    expect(f.client.state.error).not.toBeNull();
  }
});
test("disconnect during authorization and disposal suppress late native effects", async () => {
  for (const mode of ["disconnect", "dispose"]) {
    const f = fixture();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.deps.authorize = async (request) => {
      await held;
      return wire({ ...request, schemaVersion: 1, authorized: true });
    };
    const request = f.client.check();
    if (mode === "disconnect") f.deps.connected = () => false;
    else f.client.dispose();
    release();
    await request;
    expect(f.trace).not.toContain("native:check");
  }
});
test("an unconfigured native build has no update network actions", async () => {
  const f = fixture();
  f.deps.native = async () =>
    wire({
      schemaVersion: 1,
      currentVersion: f.deps.currentVersion,
      scopeKey,
      requestId: null,
      version: null,
      state: "unconfigured",
    });
  await f.client.refresh();
  await f.client.check();
  await f.client.download();
  f.client.review();
  await f.client.confirm();
  expect(f.client.state.result?.state).toBe("unconfigured");
  expect(f.trace).toEqual([]);
});

test("native journal discovery restores an unresolved install after an origin change and a newer running version can reconcile it", async () => {
  const f = fixture();
  f.deps.native = async (request) => {
    expect(request.operation).toBe("status");
    return wire({
      schemaVersion: 1,
      currentVersion: f.deps.currentVersion,
      scopeKey,
      requestId: id,
      version: "1.0.0",
      state: "install-unknown",
    });
  };
  await f.client.refresh();
  expect(f.client.state.unknown).toBe(true);
  expect(f.pending()?.requestId).toBe(id);
  await f.client.check();
  expect(f.trace).toEqual(["persist"]);
  f.client.dispose();
  f.deps.currentVersion = "1.2.0";
  f.deps.native = async () =>
    wire({
      schemaVersion: 1,
      currentVersion: "1.2.0",
      scopeKey,
      requestId: id,
      version: "1.0.0",
      state: "version-observed",
    });
  const later = createNativeUpdateClient(f.deps);
  await later.refresh();
  expect(later.state.unknown).toBe(false);
  expect(f.pending()).toBeNull();
});
