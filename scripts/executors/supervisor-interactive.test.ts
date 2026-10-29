import { expect, test } from "bun:test";
import { join } from "node:path";
import { buildChildEnv } from "./env";
import {
  killTree,
  liveChildCount,
  supervise,
  SupervisorOwnershipRefusalError,
} from "./supervisor";
import { guardRequiredTree, guardSuspendedWindowsProcess } from "./tree-guard";
import type {
  WindowsJobSettlementFailurePhase,
  WindowsJobSettlementGenerationFailureWitness,
  WindowsJobSettlementUnaccountedFailureWitness,
} from "./windows-job-settlement";

const fake = join(import.meta.dir, "fixtures/interactive-cli.ts");

type SettlementTestGuard = {
  release(): void;
  terminate(): void;
  settleStopped(): Promise<void>;
};

function heldWindowsSettlementGuard() {
  let enter!: () => void;
  let confirm!: () => void;
  let refuse!: (error: Error) => void;
  let actual: ReturnType<typeof guardRequiredTree> = null;
  let actualSettlement: Promise<void> | null = null;
  let wrappedSettlement: Promise<void> | null = null;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const settlement = new Promise<void>((resolve, reject) => {
    confirm = resolve;
    refuse = reject;
  });
  void settlement.catch(() => undefined);
  const calls: string[] = [];
  const guard: SettlementTestGuard = {
    release() {
      calls.push("release");
      actual?.release();
    },
    terminate() {
      // Keep the real job handle open so the deferred settlement can own it.
      calls.push("terminate");
    },
    settleStopped() {
      if (wrappedSettlement) return wrappedSettlement;
      calls.push("settle-start");
      enter();
      wrappedSettlement = (async () => {
        await settlement;
        if (!actual?.settleStopped)
          throw new Error("The retained Windows job cannot settle.");
        actualSettlement ??= actual.settleStopped();
        await actualSettlement;
        calls.push("settle-confirmed");
      })();
      return wrappedSettlement;
    },
  };
  return {
    guard,
    entered,
    confirm,
    refuse,
    calls,
    attach(pid: number) {
      actual = guardRequiredTree(pid);
      if (!actual?.settleStopped)
        throw new Error("A retained Windows job could not be created.");
      return guard;
    },
    async cleanup() {
      confirm();
      if (wrappedSettlement) await wrappedSettlement.catch(() => undefined);
      if (actual?.settleStopped) {
        actualSettlement ??= actual.settleStopped();
        await actualSettlement.catch(() => undefined);
      }
    },
  };
}

test("a trusted shift lifetime reaches the ownership grant exactly rather than shortening the reviewed timeout", async () => {
  const lines: string[] = [];
  const handle = supervise({
    windowsHide: true,
    command: [process.execPath, fake],
    bootstrapCommand: [
      process.execPath,
      join(import.meta.dir, "fixtures/interactive-control.ts"),
      "lifetime",
    ],
    cwd: import.meta.dir,
    env: buildChildEnv(process.env, []),
    stdinMode: "interactive",
    lifetime: "shift-attempt",
    timeoutMs: 2 * 60 * 60_000,
    onLine: (line) => lines.push(line),
  });
  try {
    await handle.done;
    expect(lines).toEqual([
      JSON.stringify({
        timeoutMs: 7_200_000,
        lifetime: "shift-attempt",
        windowsHide: true,
      }),
    ]);
  } finally {
    await handle.stop("fixture cleanup");
  }
});

test("false and omitted caller window options remain absent from the private grant", async () => {
  for (const windowsHide of [undefined, false]) {
    const lines: string[] = [];
    const handle = supervise({
      ...(windowsHide === undefined ? {} : { windowsHide }),
      spawn(command, options) {
        return Bun.spawn(command, { ...options, windowsHide: true });
      },
      command: [process.execPath, fake],
      bootstrapCommand: [
        process.execPath,
        join(import.meta.dir, "fixtures/interactive-control.ts"),
        "lifetime",
      ],
      cwd: import.meta.dir,
      env: buildChildEnv(process.env, []),
      stdinMode: "interactive",
      lifetime: "shift-attempt",
      timeoutMs: 2 * 60 * 60_000,
      onLine: (line) => lines.push(line),
    });
    try {
      await handle.done;
      expect(lines).toEqual([
        JSON.stringify({
          timeoutMs: 7_200_000,
          lifetime: "shift-attempt",
          windowsHide: null,
        }),
      ]);
    } finally {
      await handle.stop("fixture cleanup");
    }
  }
});

test("interactive supervision exchanges multiple private stdin frames before explicit EOF", async () => {
  const lines: string[] = [];
  const before = liveChildCount();
  const handle = supervise({
    windowsHide: true,
    command: [process.execPath, fake],
    cwd: import.meta.dir,
    env: buildChildEnv(process.env, []),
    stdinMode: "interactive",
    timeoutMs: 5000,
    onLine: (line) => lines.push(line),
  });
  try {
    await handle.write('private "quoted" frame\n');
    await handle.write("second 🌱 frame\n");
    await handle.end();
    expect(await handle.done).toEqual({
      exitCode: 0,
      timedOut: false,
      stopped: false,
      ownedTreeReleased: true,
      stderr: "",
    });
    expect(lines).toEqual([
      JSON.stringify({ received: 'private "quoted" frame' }),
      JSON.stringify({ received: "second 🌱 frame" }),
      JSON.stringify({ ended: true }),
    ]);
    await expect(handle.write("late")).rejects.toThrow("closed");
    expect(liveChildCount()).toBe(before);
  } finally {
    await handle.stop("fixture cleanup");
  }
});

function tree(
  mode: "blocked" | "exit-tree",
  stdinTimeoutMs = 2000,
  maxStdinBytes = 8 * 1024 * 1024,
  ownership?: ReturnType<typeof heldWindowsSettlementGuard>,
  timeoutMs = 5000,
  onFailurePhase?: (
    phase: WindowsJobSettlementFailurePhase,
    generationFailure?: WindowsJobSettlementGenerationFailureWitness,
    unaccountedFailure?: WindowsJobSettlementUnaccountedFailureWitness,
  ) => void,
) {
  let announce: (line: string) => void = () => undefined;
  const ready = new Promise<string>((resolve) => {
    announce = resolve;
  });
  const handle = supervise({
    windowsHide: true,
    command: [process.execPath, fake, mode],
    cwd: import.meta.dir,
    env: buildChildEnv(process.env, []),
    stdinMode: "interactive",
    maxStdinBytes,
    stdinTimeoutMs,
    timeoutMs,
    ...(ownership
      ? {
          interactiveGuard: (pid: number) => ownership.attach(pid),
        }
      : {}),
    ...(!ownership && process.platform === "win32" && process.arch === "x64"
      ? {
          interactiveGuard: (pid: number) =>
            guardSuspendedWindowsProcess(pid, {
              onWindowsSettlementFailure(
                phase,
                generationFailure,
                unaccountedFailure,
              ) {
                console.error(
                  JSON.stringify({
                    kind: "windows-stop-settlement-refusal",
                    phase,
                    generationFailure:
                      generationFailure === undefined
                        ? null
                        : {
                            reason: generationFailure.reason,
                            initialTotal: generationFailure.initialTotal,
                            capturedTotal: generationFailure.capturedTotal,
                            retainedCount: generationFailure.retainedCount,
                            capturedMemberCount:
                              generationFailure.capturedMemberCount,
                          },
                    accountingFailure:
                      unaccountedFailure === undefined
                        ? null
                        : {
                            activeCount: unaccountedFailure.activeCount,
                            retainedCount: unaccountedFailure.retainedCount,
                            capturedMemberCount:
                              unaccountedFailure.capturedMemberCount,
                            initialTotal: unaccountedFailure.initialTotal,
                            capturedTotal: unaccountedFailure.capturedTotal,
                          },
                  }),
                );
                // The optional observer remains a phase collector for this test.
                if (
                  generationFailure === undefined &&
                  unaccountedFailure === undefined
                )
                  onFailurePhase?.(phase);
                else if (
                  generationFailure !== undefined &&
                  unaccountedFailure === undefined
                )
                  onFailurePhase?.(phase, generationFailure);
                else
                  onFailurePhase?.(
                    phase,
                    generationFailure,
                    unaccountedFailure,
                  );
              },
            }),
        }
      : {}),
    onLine: announce,
  });
  const childPid = async () => {
    const line = await ready;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("Malformed interactive fixture announcement.");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("childPid" in parsed) ||
      typeof parsed.childPid !== "number"
    )
      throw new Error("Interactive fixture did not announce its child.");
    return parsed.childPid;
  };
  return { handle, childPid };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function gone(pid: number) {
  const deadline = Date.now() + 2000;
  while (alive(pid) && Date.now() < deadline) await Bun.sleep(20);
  return !alive(pid);
}

test("a non-reader cannot accept unlimited buffered input across settled writes", async () => {
  const f = tree("blocked", 2000, 1024);
  const child = await f.childPid();
  try {
    // Windows may acknowledge buffering before the child reads. The cap remains cumulative.
    await f.handle.write("x".repeat(512));
    await f.handle.write("x".repeat(512));
    await expect(f.handle.write("x")).rejects.toThrow("total byte bound");
    const exit = await f.handle.done;
    // Windows job termination may report zero; the rejected write is independent failure evidence.
    expect(exit.timedOut).toBe(false);
    expect(await gone(f.handle.pid)).toBe(true);
    expect(await gone(child)).toBe(true);
  } finally {
    await f.handle.stop("fixture cleanup");
    if (alive(child)) killTree(child);
  }
});

test("a saturated pipe has a deadline even when the host accepts earlier buffering", async () => {
  const f = tree("blocked", 200, 16 * 1024 * 1024);
  const child = await f.childPid();
  try {
    const result = await f.handle.write("x".repeat(16 * 1024 * 1024)).then(
      () => "accepted",
      (error: unknown) => (error instanceof Error ? error.message : "invalid"),
    );
    // Pipe capacity is an OS detail. Either the cumulative cap or the deadline stops growth.
    expect([
      "accepted",
      "Interactive stdin exceeded its write deadline.",
    ]).toContain(result);
    if (result === "accepted")
      await expect(f.handle.write("x")).rejects.toThrow("total byte bound");
    await f.handle.done;
    expect(await gone(child)).toBe(true);
  } finally {
    await f.handle.stop("fixture cleanup");
    if (alive(child)) killTree(child);
  }
});

test("Stop settles a backpressured write and EOF while confirming descendant cleanup", async () => {
  const phases: WindowsJobSettlementFailurePhase[] = [];
  const f = tree("blocked", 2000, 8 * 1024 * 1024, undefined, 5000, (phase) =>
    phases.push(phase),
  );
  const child = await f.childPid();
  const writing = f.handle.write("x".repeat(4 * 1024 * 1024));
  const ending = f.handle.end();
  const settled = Promise.allSettled([writing, ending]);
  try {
    try {
      await f.handle.stop("explicit Stop");
    } catch (error) {
      if (phases.length === 0)
        console.error(
          JSON.stringify({
            kind: "windows-stop-settlement-refusal",
            phase: "unavailable",
          }),
        );
      throw error;
    }
    expect((await settled).map((entry) => entry.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect((await f.handle.done).stopped).toBe(true);
    expect(await gone(child)).toBe(true);
  } finally {
    await f.handle.stop("fixture cleanup");
    if (alive(child)) killTree(child);
  }
});

test("interactive normal parent exit closes the ownership job and cleans its helpers", async () => {
  const f = tree("exit-tree");
  const child = await f.childPid();
  try {
    expect((await f.handle.done).exitCode).toBe(0);
    expect(await gone(child)).toBe(true);
    await expect(f.handle.end()).rejects.toThrow("closed");
  } finally {
    await f.handle.stop("fixture cleanup");
    if (alive(child)) killTree(child);
  }
});

test("Windows interactive natural exit waits for held helper settlement before reporting owner release", async () => {
  if (process.platform !== "win32") return;
  const ownership = heldWindowsSettlementGuard();
  const f = tree("exit-tree", 2000, 8 * 1024 * 1024, ownership);
  try {
    expect(await f.childPid()).toBeGreaterThan(0);
    expect(
      await Promise.race([
        ownership.entered.then(() => "settling" as const),
        Bun.sleep(1000).then(() => "not-settling" as const),
      ]),
    ).toBe("settling");
    expect(ownership.calls).toEqual(["settle-start"]);
    expect(
      await Promise.race([
        f.handle.done.then(
          () => "done" as const,
          () => "rejected" as const,
        ),
        Bun.sleep(25).then(() => "held" as const),
      ]),
    ).toBe("held");

    ownership.confirm();
    const result = await f.handle.done;
    expect(result).toMatchObject({
      exitCode: 0,
      stopped: false,
      timedOut: false,
      ownedTreeReleased: true,
    });
    expect(ownership.calls.indexOf("settle-confirmed")).toBeGreaterThan(
      ownership.calls.indexOf("settle-start"),
    );
    expect(ownership.calls.indexOf("release")).toBeGreaterThan(
      ownership.calls.indexOf("settle-confirmed"),
    );
  } finally {
    await ownership.cleanup();
    await f.handle.done.catch(() => undefined);
  }
});

test("Windows interactive Stop waits for held helper settlement and preserves stop attribution", async () => {
  if (process.platform !== "win32") return;
  const ownership = heldWindowsSettlementGuard();
  const f = tree("blocked", 2000, 8 * 1024 * 1024, ownership);
  let stopping: Promise<void> | null = null;
  try {
    expect(await f.childPid()).toBeGreaterThan(0);
    stopping = f.handle.stop("explicit terminal Stop");
    expect(
      await Promise.race([
        ownership.entered.then(() => "settling" as const),
        Bun.sleep(1000).then(() => "not-settling" as const),
      ]),
    ).toBe("settling");
    expect(ownership.calls).toEqual(["settle-start"]);
    expect(
      await Promise.race([
        f.handle.done.then(
          () => "done" as const,
          () => "rejected" as const,
        ),
        Bun.sleep(25).then(() => "held" as const),
      ]),
    ).toBe("held");

    ownership.confirm();
    const result = await f.handle.done;
    await stopping;
    expect(result).toMatchObject({
      stopped: true,
      timedOut: false,
      ownedTreeReleased: true,
    });
    expect(ownership.calls.indexOf("settle-confirmed")).toBeGreaterThan(
      ownership.calls.indexOf("settle-start"),
    );
    expect(ownership.calls.indexOf("release")).toBeGreaterThan(
      ownership.calls.indexOf("settle-confirmed"),
    );
  } finally {
    await ownership.cleanup();
    await f.handle.done.catch(() => undefined);
    await stopping?.catch(() => undefined);
  }
});

test("Windows interactive timeout waits for held helper settlement without changing timeout attribution", async () => {
  if (process.platform !== "win32") return;
  const ownership = heldWindowsSettlementGuard();
  const f = tree("blocked", 2000, 8 * 1024 * 1024, ownership, 1000);
  try {
    expect(await f.childPid()).toBeGreaterThan(0);
    expect(
      await Promise.race([
        ownership.entered.then(() => "settling" as const),
        Bun.sleep(2000).then(() => "not-settling" as const),
      ]),
    ).toBe("settling");
    expect(ownership.calls).toEqual(["settle-start"]);
    expect(
      await Promise.race([
        f.handle.done.then(
          () => "done" as const,
          () => "rejected" as const,
        ),
        Bun.sleep(25).then(() => "held" as const),
      ]),
    ).toBe("held");

    ownership.confirm();
    const result = await f.handle.done;
    expect(result).toMatchObject({
      stopped: false,
      timedOut: true,
      ownedTreeReleased: true,
    });
    expect(ownership.calls.indexOf("settle-confirmed")).toBeGreaterThan(
      ownership.calls.indexOf("settle-start"),
    );
    expect(ownership.calls.indexOf("release")).toBeGreaterThan(
      ownership.calls.indexOf("settle-confirmed"),
    );
  } finally {
    await ownership.cleanup();
    await f.handle.done.catch(() => undefined);
  }
});

test("Windows interactive refused tree settlement cannot report a released owner", async () => {
  if (process.platform !== "win32") return;
  const ownership = heldWindowsSettlementGuard();
  const f = tree("exit-tree", 2000, 8 * 1024 * 1024, ownership, 5000);
  try {
    expect(await f.childPid()).toBeGreaterThan(0);
    expect(
      await Promise.race([
        ownership.entered.then(() => "settling" as const),
        Bun.sleep(1000).then(() => "not-settling" as const),
      ]),
    ).toBe("settling");
    expect(ownership.calls).toEqual(["settle-start"]);
    ownership.refuse(
      new Error("Windows owned process cleanup could not be confirmed."),
    );
    await expect(f.handle.done).rejects.toThrow(
      "Windows owned process cleanup could not be confirmed.",
    );
    await expect(f.handle.done).rejects.toBeInstanceOf(
      SupervisorOwnershipRefusalError,
    );
    expect(ownership.calls).not.toContain("release");
  } finally {
    await ownership.cleanup();
    await f.handle.done.catch(() => undefined);
  }
});

test("Windows interactive missing settlement capability retains its real job until owner cleanup", async () => {
  if (process.platform !== "win32") return;
  const actual: { guard: ReturnType<typeof guardRequiredTree> } = {
    guard: null,
  };
  let terminateCalls = 0;
  let releaseCalls = 0;
  let announce!: (line: string) => void;
  const ready = new Promise<string>((resolve) => {
    announce = resolve;
  });
  const handle = supervise({
    windowsHide: true,
    command: [process.execPath, fake, "blocked"],
    cwd: import.meta.dir,
    env: buildChildEnv(process.env, []),
    stdinMode: "interactive",
    timeoutMs: 5000,
    interactiveGuard(pid) {
      const realGuard = guardRequiredTree(pid);
      if (!realGuard)
        throw new Error("The real process job could not be created.");
      actual.guard = realGuard;
      return {
        release() {
          releaseCalls++;
          realGuard.release();
        },
        // Deliberately withhold settleStopped while retaining the real job.
        // Production must not fall back to PID-based tree termination here.
        terminate() {
          terminateCalls++;
        },
      };
    },
    onLine: announce,
  });
  let childPid = 0;
  let stopping: Promise<void> | null = null;
  try {
    const line = await ready;
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("childPid" in parsed) ||
      typeof parsed.childPid !== "number"
    )
      throw new Error("The real-job fixture did not announce its helper.");
    childPid = parsed.childPid;

    stopping = handle.stop("missing settlement capability fixture");
    await expect(stopping).rejects.toThrow(
      "Windows owned process cleanup could not be confirmed.",
    );
    await expect(stopping).rejects.toBeInstanceOf(
      SupervisorOwnershipRefusalError,
    );
    await expect(handle.done).rejects.toThrow(
      "Windows owned process cleanup could not be confirmed.",
    );
    await expect(handle.done).rejects.toBeInstanceOf(
      SupervisorOwnershipRefusalError,
    );
    expect(terminateCalls).toBeGreaterThan(0);
    expect(releaseCalls).toBe(0);
    expect(await gone(childPid)).toBe(false);
  } finally {
    const realGuard = actual.guard;
    if (realGuard?.settleStopped) await realGuard.settleStopped();
    await handle.done.catch(() => undefined);
    await stopping?.catch(() => undefined);
    if (childPid > 0) expect(await gone(childPid)).toBe(true);
  }
});

test("interactive queue bounds reject before buffering oversized input and preserve legacy stdin", async () => {
  const before = liveChildCount();
  const handle = supervise({
    windowsHide: true,
    command: [process.execPath, fake],
    cwd: import.meta.dir,
    env: buildChildEnv(process.env, []),
    stdinMode: "interactive",
    maxStdinBytes: 3,
    timeoutMs: 5000,
    onLine: () => undefined,
  });
  try {
    await expect(handle.write("🌱")).rejects.toThrow("queue bound");
    await expect(handle.write("x")).rejects.toThrow("closed");
    await handle.done;
    expect(liveChildCount()).toBe(before);
  } finally {
    await handle.stop("fixture cleanup");
  }
  const lines: string[] = [];
  const legacy = supervise({
    windowsHide: true,
    command: [process.execPath, fake],
    cwd: import.meta.dir,
    env: buildChildEnv(process.env, []),
    stdin: "one-shot\n",
    timeoutMs: 5000,
    onLine: (line) => lines.push(line),
  });
  expect((await legacy.done).exitCode).toBe(0);
  expect(lines).toEqual(['{"received":"one-shot"}', '{"ended":true}']);
});

test("a failed mandatory ownership guard refuses before any protocol stdin", async () => {
  let pid = 0;
  const before = liveChildCount();
  let refusal: unknown;
  let unexpectedlyStarted: ReturnType<typeof supervise> | undefined;
  try {
    unexpectedlyStarted = supervise({
      windowsHide: true,
      command: [process.execPath, fake],
      cwd: import.meta.dir,
      env: buildChildEnv(process.env, []),
      stdinMode: "interactive",
      timeoutMs: 5000,
      interactiveGuard(value) {
        pid = value;
        return null;
      },
      onLine: () => {
        throw new Error(
          "No failed-ownership child may deliver a protocol frame.",
        );
      },
    });
  } catch (error) {
    refusal = error;
  }
  if (unexpectedlyStarted)
    await unexpectedlyStarted.stop("unexpected ownership acceptance");
  expect(refusal).toBeInstanceOf(Error);
  expect(refusal instanceof Error ? refusal.message : null).toBe(
    "Interactive child ownership could not be established.",
  );
  expect(pid).toBeGreaterThan(0);
  expect(await gone(pid)).toBe(true);
  expect(liveChildCount()).toBe(before);
  expect(refusal).toBeInstanceOf(SupervisorOwnershipRefusalError);
});

test("private terminal receipt failures preserve typed ownership uncertainty", async () => {
  for (const mode of [
    "malformed",
    "duplicate",
    "terminal-invalid-missing",
  ]) {
    let errors = 0;
    const handle = supervise({
      windowsHide: true,
      command: [process.execPath, fake],
      bootstrapCommand: [
        process.execPath,
        join(import.meta.dir, "fixtures/interactive-control.ts"),
        mode,
      ],
      cwd: import.meta.dir,
      env: buildChildEnv(process.env, []),
      stdinMode: "interactive",
      timeoutMs: 2000,
      onOutputError: () => {
        errors++;
      },
      onLine: () => {
        throw Error("Control frames cannot enter provider output.");
      },
    });
    try {
      await expect(handle.done).rejects.toThrow(
        "The private interactive terminal could not be confirmed.",
      );
      await expect(handle.done).rejects.toBeInstanceOf(
        SupervisorOwnershipRefusalError,
      );
      expect(errors).toBe(mode === "terminal-invalid-missing" ? 0 : 1);
      await expect(handle.write("late")).rejects.toThrow("closed");
      expect(await gone(handle.pid)).toBe(true);
    } finally {
      await expect(handle.stop("fixture cleanup")).rejects.toThrow(
        "The private interactive terminal could not be confirmed.",
      );
      await expect(handle.stop("fixture cleanup")).rejects.toBeInstanceOf(
        SupervisorOwnershipRefusalError,
      );
    }
  }
});

test("the actual provider inherits neither bootstrap IPC API nor channel environment", async () => {
  const lines: string[] = [];
  const handle = supervise({
    windowsHide: true,
    command: [process.execPath, fake, "ipc-probe"],
    cwd: import.meta.dir,
    env: buildChildEnv(process.env, []),
    stdinMode: "interactive",
    timeoutMs: 2000,
    onLine: (line) => {
      lines.push(line);
    },
  });
  try {
    expect((await handle.done).exitCode).toBe(0);
    expect(lines).toEqual(['{"providerHasIpc":false,"channelEnvironment":[]}']);
  } finally {
    await handle.stop("fixture cleanup");
  }
});

test("interactive inherited stdout and stderr retain cumulative byte bounds in the parent", async () => {
  for (const mode of ["stdout-flood", "stderr-flood"]) {
    let errors = 0;
    const handle = supervise({
      windowsHide: true,
      command: [process.execPath, fake, mode],
      cwd: import.meta.dir,
      env: buildChildEnv(process.env, []),
      stdinMode: "interactive",
      timeoutMs: 3000,
      onLine: () => {},
      onOutputError: () => {
        errors++;
      },
    });
    try {
      expect((await handle.done).timedOut).toBe(false);
      expect(errors).toBe(1);
      expect(await gone(handle.pid)).toBe(true);
    } finally {
      await handle.stop("fixture cleanup");
    }
  }
});
