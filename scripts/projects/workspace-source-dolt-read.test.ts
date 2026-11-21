import { expect, test } from "bun:test";
import {
  createWorkspaceReadReservation,
  readReservedWorkspaceProjection,
  type WorkspaceReadEvent,
  type WorkspaceReadParts,
  type WorkspaceReadPort,
  type WorkspaceReadReservation,
} from "./workspace-source-dolt-read";

const expectedParts: WorkspaceReadParts<string> = {
  identity: "identity",
  issues: "issues",
  durableLabels: "durable-labels",
  wispLabels: "wisp-labels",
  dependencies: "dependencies",
};

type ReadName =
  | "identity"
  | "issues"
  | "durableLabels"
  | "wispLabels"
  | "dependencies";
type PortOptions = {
  subscribeThrows?: boolean;
  subscribeEvent?: WorkspaceReadEvent;
  reserve?: (
    reservation: WorkspaceReadReservation,
  ) => Promise<WorkspaceReadReservation | null>;
  rejectRead?: ReadName;
  closeFails?: boolean;
  unsubscribeFails?: boolean;
  closeEvent?: WorkspaceReadEvent;
  unsubscribeEvent?: WorkspaceReadEvent;
};
function makePort(
  readIdentity?: () => Promise<string>,
  readIssues?: () => Promise<string>,
  options: PortOptions = {},
) {
  const reservation = createWorkspaceReadReservation();
  const calls: string[] = [];
  let listener: ((event: WorkspaceReadEvent) => void) | undefined;
  const check = (candidate: WorkspaceReadReservation) => {
    expect(candidate).toBe(reservation);
  };
  const runRead = (
    name: ReadName,
    value: string,
    override?: () => Promise<string>,
  ) => {
    calls.push(name);
    if (options.rejectRead === name)
      return Promise.reject(new Error("read failed"));
    return override ? override() : Promise.resolve(value);
  };
  const port: WorkspaceReadPort<string> = {
    subscribe(next) {
      calls.push("subscribe");
      listener = next;
      if (options.subscribeThrows) throw new Error("subscribe failed");
      if (options.subscribeEvent) next(options.subscribeEvent);
      return () => {
        calls.push("unsubscribe");
        if (options.unsubscribeEvent) listener?.(options.unsubscribeEvent);
        if (options.unsubscribeFails) throw new Error("unsubscribe failed");
      };
    },
    async reserveOnce() {
      calls.push("reserve");
      return options.reserve ? options.reserve(reservation) : reservation;
    },
    async readIdentity(candidate) {
      check(candidate);
      return runRead("identity", expectedParts.identity, readIdentity);
    },
    async readIssues(candidate) {
      check(candidate);
      return runRead("issues", expectedParts.issues, readIssues);
    },
    async readDurableLabels(candidate) {
      check(candidate);
      return runRead("durableLabels", expectedParts.durableLabels);
    },
    async readWispLabels(candidate) {
      check(candidate);
      return runRead("wispLabels", expectedParts.wispLabels);
    },
    async readDependencies(candidate) {
      check(candidate);
      return runRead("dependencies", expectedParts.dependencies);
    },
    async closeLocally(candidate) {
      check(candidate);
      calls.push("close");
      if (options.closeEvent) listener?.(options.closeEvent);
      if (options.closeFails) throw new Error("close failed");
    },
  };
  return {
    port,
    calls,
    reservation,
    emit(event: WorkspaceReadEvent) {
      listener?.(event);
    },
  };
}

function deferred<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
test("reads all fixed parts on one opaque reservation and closes it", async () => {
  const fake = makePort();
  const result = await readReservedWorkspaceProjection(fake.port);
  expect(result).toEqual({ kind: "read", parts: expectedParts });
  expect(fake.calls).toEqual([
    "subscribe",
    "reserve",
    "identity",
    "issues",
    "durableLabels",
    "wispLabels",
    "dependencies",
    "close",
    "unsubscribe",
  ]);
});

test("loss after identity prevents the next fixed read", async () => {
  let resolveIdentity!: (value: string) => void;
  const identity = new Promise<string>((resolve) => {
    resolveIdentity = resolve;
  });
  const fake = makePort(() => identity);
  const pending = readReservedWorkspaceProjection(fake.port);

  await Promise.resolve();
  expect(fake.calls).toContain("identity");
  resolveIdentity(expectedParts.identity);
  fake.emit("loss");

  const result = await pending;
  expect(fake.calls).not.toContain("issues");
  expect(result).toEqual({ kind: "unavailable" });
  expect(fake.calls.slice(-2)).toEqual(["close", "unsubscribe"]);
});

test("loss during a pending issues read discards late rows", async () => {
  const entered = deferred<void>();
  const releaseRows = deferred<string>();
  const fake = makePort(undefined, () => {
    entered.release(undefined);
    return releaseRows.promise;
  });
  const pending = readReservedWorkspaceProjection(fake.port);

  await entered.promise;
  fake.emit("loss");
  releaseRows.release("late issue rows");

  const result = await pending;
  expect(result).toEqual({ kind: "unavailable" });
  expect(fake.calls).not.toContain("durableLabels");
  expect(fake.calls).not.toContain("wispLabels");
  expect(fake.calls).not.toContain("dependencies");
  expect(fake.calls).toEqual([
    "subscribe",
    "reserve",
    "identity",
    "issues",
    "close",
    "unsubscribe",
  ]);
});

test("open after loss during a pending read cannot restore it", async () => {
  const entered = deferred<void>();
  const releaseRows = deferred<string>();
  const fake = makePort(undefined, () => {
    entered.release(undefined);
    return releaseRows.promise;
  });
  const pending = readReservedWorkspaceProjection(fake.port);

  await entered.promise;
  fake.emit("loss");
  fake.emit("open");
  releaseRows.release("late issue rows");

  const result = await pending;
  expect(result).toEqual({ kind: "unavailable" });
  expect(fake.calls).not.toContain("durableLabels");
  expect(fake.calls).not.toContain("wispLabels");
  expect(fake.calls).not.toContain("dependencies");
  expect(fake.calls).toEqual([
    "subscribe",
    "reserve",
    "identity",
    "issues",
    "close",
    "unsubscribe",
  ]);
});

test("subscription failure and synchronous loss never reserve", async () => {
  const thrown = makePort(undefined, undefined, { subscribeThrows: true });
  expect(await readReservedWorkspaceProjection(thrown.port)).toEqual({
    kind: "unavailable",
  });
  expect(thrown.calls).toEqual(["subscribe"]);

  const lost = makePort(undefined, undefined, { subscribeEvent: "loss" });
  expect(await readReservedWorkspaceProjection(lost.port)).toEqual({
    kind: "unavailable",
  });
  expect(lost.calls).toEqual(["subscribe", "unsubscribe"]);
  for (const event of ["close", "error"] as const) {
    const terminal = makePort(undefined, undefined, { subscribeEvent: event });
    expect(await readReservedWorkspaceProjection(terminal.port)).toEqual({
      kind: "unavailable",
    });
    expect(terminal.calls).toEqual(["subscribe", "unsubscribe"]);
  }
});

test("null or rejected reserve unsubscribes once without a close", async () => {
  for (const reserve of [
    async () => null,
    async () => {
      throw new Error("reserve failed");
    },
  ]) {
    const fake = makePort(undefined, undefined, { reserve });
    expect(await readReservedWorkspaceProjection(fake.port)).toEqual({
      kind: "unavailable",
    });
    expect(fake.calls).toEqual(["subscribe", "reserve", "unsubscribe"]);
  }
});

test("loss during reserve closes only the eventual handle", async () => {
  const entered = deferred<void>();
  const releaseReservation = deferred<WorkspaceReadReservation | null>();
  const fake = makePort(undefined, undefined, {
    reserve: () => {
      entered.release(undefined);
      return releaseReservation.promise;
    },
  });
  const pending = readReservedWorkspaceProjection(fake.port);

  await entered.promise;
  fake.emit("loss");
  releaseReservation.release(fake.reservation);

  expect(await pending).toEqual({ kind: "unavailable" });
  expect(fake.calls).toEqual(["subscribe", "reserve", "close", "unsubscribe"]);
});

test("each fixed read rejection stops later dispatch", async () => {
  const sequence: ReadName[] = [
    "identity",
    "issues",
    "durableLabels",
    "wispLabels",
    "dependencies",
  ];
  for (const [index, rejectRead] of sequence.entries()) {
    const fake = makePort(undefined, undefined, { rejectRead });
    const expected = [
      "subscribe",
      "reserve",
      ...sequence.slice(0, index + 1),
      "close",
      "unsubscribe",
    ];
    expect(await readReservedWorkspaceProjection(fake.port)).toEqual({
      kind: "unavailable",
    });
    expect(fake.calls).toEqual(expected);
  }
});

test("close and unsubscribe failures are both attempted and unavailable", async () => {
  for (const options of [
    { closeFails: true },
    { unsubscribeFails: true },
    { closeFails: true, unsubscribeFails: true },
  ]) {
    const fake = makePort(undefined, undefined, options);
    expect(await readReservedWorkspaceProjection(fake.port)).toEqual({
      kind: "unavailable",
    });
    expect(fake.calls.slice(-2)).toEqual(["close", "unsubscribe"]);
    expect(fake.calls.filter((call) => call === "close")).toHaveLength(1);
    expect(fake.calls.filter((call) => call === "unsubscribe")).toHaveLength(1);
  }
});

test("terminal events during close or unsubscribe refuse publication", async () => {
  for (const options of [
    { closeEvent: "close" as const },
    { unsubscribeEvent: "error" as const },
  ]) {
    const fake = makePort(undefined, undefined, options);
    expect(await readReservedWorkspaceProjection(fake.port)).toEqual({
      kind: "unavailable",
    });
    expect(fake.calls.slice(-2)).toEqual(["close", "unsubscribe"]);
  }
});
