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
import { readHomeLock } from "./home-guard";
import {
  type HearthLock,
  isPidAlive,
  readLock,
  releaseLock,
  sameLock,
  updateLock,
} from "./lock";
import { healthProblem, healthReport } from "./loopback";

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

/**
 * Whether the lock names a live hearth: its pid is alive and its port answers
 * the health route with that pid and the root the lock names. A live pid alone
 * is not enough: the pid of a hearth that was killed can belong to any process
 * by now. Used by this supervisor and by a hearth started directly
 * (`createHearth`).
 *
 * Asked over `loopbackExchange`, not `fetch`: under Bun, `fetch` sends a
 * request for `127.0.0.1` to `HTTP_PROXY` unless `NO_PROXY` covers it, which
 * would judge a healthy hearth unhealthy.
 */
export async function isHealthy(lock: HearthLock): Promise<boolean> {
  if (!isPidAlive(lock.pid)) return false;
  return (await healthProblem(lock)) === null;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

export function createSupervisor(options: SupervisorOptions): HearthSupervisor {
  const root = resolve(options.root);
  const file = lockPath(options.home, root);
  const timeout = options.startTimeoutMs ?? 20_000;
  let preferredPort: number | undefined;
  /** The lock this supervisor attached to, as it was read with the check. */
  let attached: HearthLock | null = null;
  let inflight: Promise<number> | null = null;

  /**
   * The lock, read as it is checked (`readHomeLock`). Refuses a home, or a
   * lock file, that others can write: they could name the port the dashboard
   * proxies the page's requests to, the operator token with them
   * (`home-guard.ts`). The same check the hearth makes at start, so a home
   * it would refuse is refused here with its words, before a hearth is
   * started at all. A port is taken only from a lock read so: what was
   * checked is what is used (`x1gs.3.38`).
   */
  function trustedLock(): HearthLock | null {
    const read = readHomeLock(options.home, file);
    if (read.problem !== null)
      throw new Error(
        `Refusing to use the control plane for ${root}: ${read.problem}`,
      );
    return read.lock;
  }

  async function attachOrStart(): Promise<number> {
    const current = trustedLock();
    if (
      current &&
      resolve(current.root) === root &&
      (await isHealthy(current))
    ) {
      // The lock checked above, never one read again by the path (`updateLock`).
      updateLock(file, current, { supervisor: options.id });
      attached = current;
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
    // A hearth that refused to start exits 1 at once; one that found another
    // hearth of this root running exits 0, and that one's lock is found below.
    child.once("exit", (code) => {
      if (code !== 0 && code !== null)
        failed ??= new Error(
          `The hearth exited with code ${code} before it answered. It says why when started directly: bun run hearth, with AGENT_FORGE_HOME=${options.home}, in ${root}`,
        );
    });
    // The child is independent of this process; it must not hold it open.
    child.unref();

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (failed) throw failed;
      const seen = readLock(file);
      if (seen && seen.pid !== current?.pid && (await isHealthy(seen))) {
        // Asked of a lock read by its path, to wait cheaply: used only once
        // the lock read as it is checked is that same lock.
        const lock = trustedLock();
        if (lock !== null && sameLock(lock, seen)) {
          updateLock(file, lock, { supervisor: options.id });
          attached = lock;
          preferredPort = lock.port;
          return lock.port;
        }
      }
      await sleep(100);
    }
    throw new Error("The hearth did not start in time");
  }

  return {
    ensure() {
      // Fast path once attached: a cheap pid check per request, no HTTP probe.
      // Only while the lock at the path is still the one checked at attach,
      // and that hearth's own pid is alive: a lock put there since, naming
      // this port and some other live pid, cannot hide that the hearth ended
      // and let another program take its port (`x1gs.3.38`).
      if (
        preferredPort !== undefined &&
        attached !== null &&
        attached.port === preferredPort &&
        sameLock(readLock(file), attached) &&
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
      // It ends the pid the lock names: read as it is checked, and never from a home others can write.
      let lock: HearthLock | null;
      try {
        lock = trustedLock();
      } catch {
        return;
      }
      if (!lock || lock.supervisor !== options.id) return;
      const report = isPidAlive(lock.pid)
        ? await healthReport(lock)
        : { problem: "its pid is not alive", silent: false };
      // A live pid whose port answered nothing in time may be the hearth, too
      // busy to answer: neither stopped nor released, so that its lock still
      // names it and the next dashboard does not start a second one for this
      // root. Whether it is the hearth is not known, so it is not stopped.
      if (report.silent) return;
      // Dead, or something else answers: the lock is stale. A recycled pid
      // must not take the blame for a hearth that already died.
      if (report.problem !== null) {
        releaseLock(file, lock.pid);
        return;
      }
      try {
        process.kill(lock.pid);
      } catch {
        // Already gone.
      }
      releaseLock(file, lock.pid);
    },
  };
}
