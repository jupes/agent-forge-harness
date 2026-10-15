/**
 * Whether the host is too busy to start more work: the share of CPU time
 * spent working since the last reading, and the share of memory in use, each
 * against one threshold (85% by default, decision 8).
 *
 * The CPU figure comes from `os.cpus()` counters, which every platform Bun
 * runs on reports, Windows included (`os.loadavg()` is all zeros there). The
 * counters run from boot, so one reading says nothing about now: the first
 * sample reads twice, a short gap apart, and each later sample measures from
 * the reading before it. Memory is `1 - freemem / totalmem`.
 */

import { cpus, freemem, totalmem } from "node:os";

/** The parts of `node:os` the sampler reads. */
export interface HostProbe {
  cpus(): ReadonlyArray<{
    times: {
      user: number;
      nice: number;
      sys: number;
      idle: number;
      irq: number;
    };
  }>;
  freemem(): number;
  totalmem(): number;
}

export interface HostLoad {
  busy: boolean;
  /** Why it is busy, when it is. */
  reason?: string;
  /** Share of CPU time spent working since the last reading; null when no time passed. */
  cpu: number | null;
  /** Share of memory in use. */
  memory: number;
}

export interface HostSamplerOptions {
  /** At or above this share, of either, the host is busy. Default 0.85. */
  threshold?: number;
  probe?: HostProbe;
  /** The gap between the two readings of the first sample. Default 500 ms. */
  gapMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_HOST_THRESHOLD = 0.85;

interface Reading {
  busy: number;
  total: number;
}

function read(probe: HostProbe): Reading {
  let busy = 0;
  let total = 0;
  for (const { times } of probe.cpus()) {
    const working = times.user + times.nice + times.sys + times.irq;
    busy += working;
    total += working + times.idle;
  }
  return { busy, total };
}

const percent = (share: number): string => `${Math.round(share * 100)}%`;
const rounded = (share: number): number => Math.round(share * 1000) / 1000;

/** A sampler: each call says how busy the host is now. */
export function createHostSampler(
  options: HostSamplerOptions = {},
): () => Promise<HostLoad> {
  const probe = options.probe ?? { cpus, freemem, totalmem };
  const threshold = options.threshold ?? DEFAULT_HOST_THRESHOLD;
  const gapMs = options.gapMs ?? 500;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  let last: Reading | null = null;

  return async () => {
    if (last === null) {
      last = read(probe);
      await sleep(gapMs);
    }
    const now = read(probe);
    const spent = now.total - last.total;
    const cpu = spent > 0 ? rounded((now.busy - last.busy) / spent) : null;
    last = now;
    const total = probe.totalmem();
    const memory = total > 0 ? rounded(1 - probe.freemem() / total) : 0;
    const reason =
      cpu !== null && cpu >= threshold
        ? `CPU ${percent(cpu)} is at or above ${percent(threshold)}`
        : memory >= threshold
          ? `memory ${percent(memory)} in use is at or above ${percent(threshold)}`
          : undefined;
    return reason !== undefined
      ? { busy: true, cpu, memory, reason }
      : { busy: false, cpu, memory };
  };
}
