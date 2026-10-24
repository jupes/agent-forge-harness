import { expect, test } from "bun:test";
import {
  createProcessGroupObserver,
  linuxProcessGroupState,
  type ProcessGroupState,
  waitForOwnedProcessGroup,
} from "./process-group";

test("a kernel-confirmed absent owned group needs no unrelated Linux process reads", async () => {
  const probes: number[] = [];
  let scans = 0;
  const observe = createProcessGroupObserver({
    platform: "linux",
    probe(group) {
      probes.push(group);
      throw Object.assign(Error("absent"), { code: "ESRCH" });
    },
    async entries() {
      scans++;
      throw Object.assign(Error("unrelated process metadata unavailable"), {
        code: "EACCES",
      });
    },
    async stat() {
      throw Error("No proc entry should be opened");
    },
  });
  expect(await observe(77, new AbortController().signal)).toBe("inactive");
  expect(probes).toEqual([77]);
  expect(scans).toBe(0);
});

test("an owned-group observer refuses process-one and invalid targets before any kernel probe", async () => {
  let calls = 0;
  const observe = createProcessGroupObserver({
    platform: "linux",
    probe() {
      calls++;
      throw Object.assign(Error("absent"), { code: "ESRCH" });
    },
    async entries() {
      calls++;
      return [];
    },
    async stat() {
      calls++;
      return "";
    },
  });
  for (const group of [1, 0, -77, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
    expect(await observe(group, new AbortController().signal)).toBe("unknown");
  expect(calls).toBe(0);
});

test("aborted kernel and proc observations cannot report a fresh absence", async () => {
  const probing = new AbortController();
  const kernel = createProcessGroupObserver({
    platform: "linux",
    probe() {
      probing.abort();
      throw Object.assign(Error("absent"), { code: "ESRCH" });
    },
    async entries() {
      throw Error("Unexpected scan");
    },
    async stat() {
      return "";
    },
  });
  expect(await kernel(77, probing.signal)).toBe("unknown");
  const listing = new AbortController();
  const list = createProcessGroupObserver({
    platform: "linux",
    probe() {},
    async entries() {
      listing.abort();
      return [];
    },
    async stat() {
      return "";
    },
  });
  expect(await list(77, listing.signal)).toBe("unknown");
  const reading = new AbortController();
  const stat = createProcessGroupObserver({
    platform: "linux",
    probe() {},
    async entries() {
      return ["78"];
    },
    async stat() {
      reading.abort();
      return "78 (helper) Z 1 77 0 0";
    },
  });
  expect(await stat(77, reading.signal)).toBe("unknown");
});

test("only ESRCH confirms kernel absence; permissions and other failures never fall back to an empty proc success", async () => {
  for (const code of ["EPERM", "EACCES", "EINVAL", "EIO"]) {
    let reads = 0;
    const observe = createProcessGroupObserver({
      platform: "linux",
      probe() {
        throw Object.assign(Error("synthetic kernel refusal"), { code });
      },
      async entries() {
        reads++;
        return [];
      },
      async stat() {
        reads++;
        return "";
      },
    });
    expect(await observe(77, new AbortController().signal)).toBe("unknown");
    expect(reads).toBe(0);
  }
});

test("a present Linux group still requires complete bounded readable membership and preserves active helpers", async () => {
  let probes = 0,
    reads = 0;
  const observe = createProcessGroupObserver({
    platform: "linux",
    probe(group) {
      expect(group).toBe(77);
      probes++;
    },
    async entries() {
      return Array.from({ length: 65 }, (_, index) => String(index + 100));
    },
    async stat(pid) {
      reads++;
      return `${pid} (helper) S 1 ${pid === "164" ? 77 : 88} 0 0`;
    },
  });
  expect(await observe(77, new AbortController().signal)).toBe("active");
  expect(probes).toBe(1);
  expect(reads).toBe(65);
  for (const mode of ["denied", "malformed", "oversized-directory"]) {
    let stats = 0;
    const unverified = createProcessGroupObserver({
      platform: "linux",
      probe() {},
      async entries() {
        if (mode === "denied")
          throw Object.assign(Error("unreadable"), { code: "EACCES" });
        return mode === "oversized-directory"
          ? Array.from({ length: 65_537 }, (_, index) => String(index + 100))
          : ["78"];
      },
      async stat() {
        stats++;
        return "unverified process metadata";
      },
    });
    expect(await unverified(77, new AbortController().signal)).toBe("unknown");
    expect(stats).toBe(mode === "malformed" ? 1 : 0);
  }
});

test("verified Linux zombie-only or disappeared members remain inactive while other platforms use only the kernel witness", async () => {
  const observe = createProcessGroupObserver({
    platform: "linux",
    probe() {},
    async entries() {
      return ["self", "78", "79", "80"];
    },
    async stat(pid) {
      if (pid === "78")
        throw Object.assign(Error("disappeared"), { code: "ENOENT" });
      return `${pid} (helper) ${pid === "79" ? "Z" : "S"} 1 ${pid === "79" ? 77 : 88} 0 0`;
    },
  });
  expect(await observe(77, new AbortController().signal)).toBe("inactive");
  for (const platform of ["darwin", "freebsd"] as const) {
    let reads = 0;
    const kernel = createProcessGroupObserver({
      platform,
      probe() {},
      async entries() {
        reads++;
        return [];
      },
      async stat() {
        reads++;
        return "";
      },
    });
    expect(await kernel(77, new AbortController().signal)).toBe("active");
    expect(reads).toBe(0);
  }
});

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
