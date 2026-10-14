import { describe, expect, test } from "bun:test";
import { createHostSampler, type HostProbe } from "./host-load";

/** A host whose counters the test sets: each `cpus()` call takes the next reading. */
function host(
  readings: Array<{ busy: number; idle: number }>,
  memory: { free: number; total: number },
): HostProbe & { calls: number } {
  const probe = {
    calls: 0,
    cpus() {
      const reading = readings[Math.min(probe.calls, readings.length - 1)] ?? {
        busy: 0,
        idle: 0,
      };
      probe.calls++;
      // Two cores, the work split between them.
      return [0, 1].map(() => ({
        times: {
          user: reading.busy / 2,
          nice: 0,
          sys: 0,
          idle: reading.idle / 2,
          irq: 0,
        },
      }));
    },
    freemem: () => memory.free,
    totalmem: () => memory.total,
  };
  return probe;
}

const noWait = async () => undefined;

describe("the host sampler", () => {
  test("the first sample reads the CPU twice, a gap apart, and is busy from what was used between the readings, not since boot", async () => {
    // Since boot the host was idle; between the two readings it was 90% busy.
    const probe = host(
      [
        { busy: 1_000, idle: 99_000 },
        { busy: 1_900, idle: 99_100 },
      ],
      { free: 50, total: 100 },
    );
    const sample = createHostSampler({ probe, sleep: noWait });
    const load = await sample();
    expect(probe.calls).toBe(2);
    expect(load).toEqual({
      busy: true,
      cpu: 0.9,
      memory: 0.5,
      reason: "CPU 90% is at or above 85%",
    });
  });

  test("a later sample measures from the one before it, with no second reading", async () => {
    const probe = host(
      [
        { busy: 0, idle: 0 },
        { busy: 100, idle: 900 },
        { busy: 200, idle: 1_800 },
      ],
      { free: 60, total: 100 },
    );
    const sample = createHostSampler({ probe, sleep: noWait });
    await sample();
    const load = await sample();
    expect(probe.calls).toBe(3);
    expect(load).toEqual({ busy: false, cpu: 0.1, memory: 0.4 });
  });

  test("memory in use at or above the threshold makes the host busy, whatever the CPU does", async () => {
    const probe = host(
      [
        { busy: 0, idle: 0 },
        { busy: 0, idle: 1_000 },
      ],
      { free: 10, total: 100 },
    );
    const load = await createHostSampler({ probe, sleep: noWait })();
    expect(load).toEqual({
      busy: true,
      cpu: 0,
      memory: 0.9,
      reason: "memory 90% in use is at or above 85%",
    });
  });

  test("the threshold is the caller's; a host with no CPU time between readings has no CPU figure and is judged on memory", async () => {
    const probe = host([{ busy: 5, idle: 5 }], { free: 30, total: 100 });
    const load = await createHostSampler({
      probe,
      sleep: noWait,
      threshold: 0.6,
    })();
    expect(load).toEqual({
      busy: true,
      cpu: null,
      memory: 0.7,
      reason: "memory 70% in use is at or above 60%",
    });
  });
});
