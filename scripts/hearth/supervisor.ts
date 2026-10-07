/**
 * Supervision of a hearth process on behalf of a dashboard dev server.
 *
 * A dashboard attaches to a live hearth for its own root when there is one, and
 * starts one otherwise. Responsibility for stopping it is tracked in the lock
 * (`supervisor`), so a dev-server restart — new server first, old one closed
 * second — hands the hearth over instead of killing it. Because a hearth can
 * still be stopped by another dashboard sharing the root, callers re-check
 * liveness before proxying and respawn on the same port, which keeps any
 * already-built proxy target valid.
 */

import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lockPath } from "./home";
import {
  type HearthLock,
  isPidAlive,
  readLock,
  releaseLock,
  updateLock,
} from "./lock";
import { HEALTH_ROUTE } from "./paths";

const SERVER_SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "server.ts",
);

export interface HearthSupervisor {
  /** Port of a live hearth for this root, starting one if needed. */
  ensure(): Promise<number>;
  /** Stop the hearth if this supervisor is still the one named in the lock. */
  stopIfOwner(): Promise<void>;
}

export interface SupervisorOptions {
  root: string;
  home: string;
  /** Identifies this supervisor in the lock. */
  id: string;
  /** Wait this long for a freshly spawned hearth to publish its lock. */
  startTimeoutMs?: number;
}

async function isHealthy(lock: HearthLock): Promise<boolean> {
  if (!isPidAlive(lock.pid)) return false;
  try {
    const res = await fetch(`http://127.0.0.1:${lock.port}${HEALTH_ROUTE}`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { data?: { pid?: number } };
    return body.data?.pid === lock.pid;
  } catch {
    return false;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

export function createSupervisor(options: SupervisorOptions): HearthSupervisor {
  const root = resolve(options.root);
  const file = lockPath(options.home, root);
  const timeout = options.startTimeoutMs ?? 20_000;
  let preferredPort: number | undefined;
  let inflight: Promise<number> | null = null;

  async function attachOrStart(): Promise<number> {
    const current = readLock(file);
    if (
      current &&
      resolve(current.root) === root &&
      (await isHealthy(current))
    ) {
      updateLock(file, { supervisor: options.id });
      preferredPort = current.port;
      return current.port;
    }
    // A lock whose process is gone (or was reused by something else) is stale.
    if (current) releaseLock(file, current.pid);

    const child = spawn("bun", [SERVER_SCRIPT, "--root", root], {
      env: {
        ...process.env,
        AGENT_FORGE_HOME: options.home,
        ...(preferredPort === undefined
          ? {}
          : { HEARTH_PORT: String(preferredPort) }),
      },
      stdio: "ignore",
      windowsHide: true,
    });
    let failed: Error | null = null;
    child.once("error", (error) => {
      failed = error;
    });
    // The child is independent of this process; it must not hold it open.
    child.unref();

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (failed) throw failed;
      const lock = readLock(file);
      if (lock && lock.pid !== current?.pid && (await isHealthy(lock))) {
        updateLock(file, { supervisor: options.id });
        preferredPort = lock.port;
        return lock.port;
      }
      await sleep(100);
    }
    throw new Error("The hearth did not start in time");
  }

  return {
    ensure() {
      // Fast path once attached: a cheap pid check per request, no HTTP probe.
      const attached = readLock(file);
      if (
        preferredPort !== undefined &&
        attached?.port === preferredPort &&
        resolve(attached.root) === root &&
        isPidAlive(attached.pid)
      ) {
        return Promise.resolve(preferredPort);
      }
      // Single-flight: concurrent callers share one start.
      inflight ??= attachOrStart().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    async stopIfOwner() {
      const lock = readLock(file);
      if (!lock || lock.supervisor !== options.id) return;
      try {
        process.kill(lock.pid);
      } catch {
        // Already gone.
      }
      releaseLock(file, lock.pid);
    },
  };
}
