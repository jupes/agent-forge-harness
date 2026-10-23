import { expect, test } from "bun:test";
import {
  linuxProcessGroupState,
  type ProcessGroupState,
  waitForOwnedProcessGroup,
} from "./process-group";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("completion stays held through a deferred kernel read and an executing owned helper", async () => {
  const first = deferred<ProcessGroupState>();
  const next = deferred<ProcessGroupState>();
  const secondRead = deferred<void>();
  let reads = 0;
  let completed = false;
  const done = waitForOwnedProcessGroup(async () => {
    if (++reads === 1) return first.promise;
    secondRead.resolve();
    return next.promise;
  }).then(() => {
    completed = true;
  });
  try {
    await Bun.sleep(0);
    expect(completed).toBe(false);
    first.resolve("active");
    await Promise.race([secondRead.promise, Bun.sleep(100)]);
    expect(reads).toBe(2);
    expect(completed).toBe(false);
    next.resolve("inactive");
    await done;
    expect(completed).toBe(true);
  } finally {
    first.resolve("inactive");
    next.resolve("inactive");
    await done;
  }
});

test("unreadable ownership refuses completion and never waits for a late successful read", async () => {
  await expect(waitForOwnedProcessGroup(async () => "unknown")).rejects.toThrow(
    "process group cleanup could not be confirmed",
  );
  const held = deferred<ProcessGroupState>();
  let signal: AbortSignal | undefined;
  const result = waitForOwnedProcessGroup(async (current) => {
    signal = current;
    return held.promise;
  }, 20).then(
    () => "completed",
    () => "unknown",
  );
  expect(await Promise.race([result, Bun.sleep(500).then(() => "hung")])).toBe(
    "unknown",
  );
  expect(signal?.aborted).toBe(true);
  held.resolve("inactive");
  await Bun.sleep(0);
  expect(await result).toBe("unknown");
});

test("Linux ownership checks active members only in the held group and treats zombies as inactive", () => {
  const stat = (pid: number, state: string, group: number) =>
    `${pid} (fixture ) name) ${state} 1 ${group} 0 0 0`;
  expect(linuxProcessGroupState(77, [stat(78, "S", 77)])).toBe("active");
  expect(linuxProcessGroupState(77, [stat(78, "T", 77)])).toBe("active");
  expect(
    linuxProcessGroupState(77, [stat(78, "Z", 77), stat(79, "S", 88)]),
  ).toBe("inactive");
  expect(linuxProcessGroupState(77, [])).toBe("inactive");
  expect(linuxProcessGroupState(77, ["unreadable stat shape"])).toBe("unknown");
});
