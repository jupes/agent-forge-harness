/**
 * Rebuild `docs/data/beads.json` from the dev server, off its thread.
 *
 * `POST /__agent-forge/rebuild-pages` (the Refresh snapshot button), the first
 * build when the server starts, a change under `.beads/` and `api.rebuildSoon`
 * all run `scripts/build-pages.ts` as a child process the server does not wait
 * on, one at a time through `createRebuildQueue`. The server keeps answering
 * other requests, the hearth proxy among them, while a build runs.
 *
 * The `.beads/` watcher does not follow the tracker: in a linked worktree bd
 * writes the main checkout's, so nothing under this `.beads/` changes. The
 * dashboard config therefore also calls `api.rebuildSoon` when the hearth
 * reports a tracker write (`scripts/hearth/follow-tracker-writes.ts`). A write
 * made with `bd` outside the hearth reaches neither in a worktree: Refresh
 * snapshot reads the tracker then.
 *
 * A rebuild the server started itself that succeeded is announced to open
 * pages with `SNAPSHOT_REBUILT_EVENT` over Vite's HMR socket, never with a
 * full reload: the page reads the snapshot again in place and keeps what it
 * holds that is not saved.
 *
 * Loaded by Vite under Node: imports nothing from Bun.
 */

import { spawn } from "node:child_process";
import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import type { Plugin } from "vite";
import { isLoopbackAddress, passesFrontDoor } from "../hearth/gate";
import { createRebuildQueue, type RebuildOutcome } from "./rebuild-queue";
import { SNAPSHOT_REBUILT_EVENT } from "./snapshot-events";

export const REBUILD_PATH = "/__agent-forge/rebuild-pages";

/** A build that takes longer is stopped and reported as failed. */
const DEFAULT_TIMEOUT_MS = 180_000;
/** How much of a build's output is kept for an error answer. */
const OUTPUT_MAX = 8000;
/** How long a requested rebuild waits for more requests to join it. */
const DEBOUNCE_MS = 700;
/**
 * After a build ends, how long a `last-touched` change is still taken as the
 * build's own. The watcher reports a change only once the file has been still
 * for 400 ms (`awaitWriteFinish`, polled every 100 ms); two seconds leaves
 * room for a loaded machine. A terminal bd command whose only trace is
 * `last-touched`, run during a build or in this window, is not rebuilt.
 */
const SELF_TOUCH_GRACE_MS = 2000;

export interface BuildCommand {
  file: string;
  args: string[];
}

export interface RebuildPagesOptions {
  /** The checkout whose snapshot is rebuilt and whose `.beads/` is watched. */
  root: string;
  /** What builds the snapshot. Default: `bun scripts/build-pages.ts` in `root`. */
  command?: BuildCommand;
  /** Build once when the server starts, without holding up its start. Default: true. */
  initialBuild?: boolean;
  /** Stop a build that runs longer than this. Default: three minutes. */
  timeoutMs?: number;
}

/**
 * Run one build as a child process. Its output goes to this terminal as it
 * arrives and the tail is kept for the outcome. Never rejects.
 */
export function runBuild(
  command: BuildCommand,
  cwd: string,
  timeoutMs: number,
): Promise<RebuildOutcome> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let gaveUp: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: RebuildOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(gaveUp);
      resolve(outcome);
    };
    const keep = (chunk: Buffer, to: NodeJS.WriteStream): void => {
      const text = chunk.toString("utf8");
      to.write(text);
      output = (output + text).slice(-OUTPUT_MAX);
    };
    const stopped = (): RebuildOutcome => ({
      ok: false,
      output:
        `${output}\nbuild-pages did not finish in ${timeoutMs / 1000} s and was stopped.`.trim(),
    });

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command.file, command.args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      finish({
        ok: false,
        output: `Could not start ${command.file}: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => keep(chunk, process.stdout));
    child.stderr?.on("data", (chunk: Buffer) => keep(chunk, process.stderr));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      // Answer even if the stopped process never reports that it closed.
      gaveUp = setTimeout(() => finish(stopped()), 5000);
    }, timeoutMs);

    child.on("error", (error) =>
      finish({
        ok: false,
        output: `Could not start ${command.file}: ${error.message}`,
      }),
    );
    child.on("close", (code) => {
      if (timedOut) finish(stopped());
      else if (code === 0) finish({ ok: true, output });
      else
        finish({
          ok: false,
          output: output || `build-pages exited with status ${code}`,
        });
    });
  });
}

export interface RebuildPagesApi {
  /**
   * Rebuild after a short pause, then tell open pages the snapshot was
   * rebuilt when the build succeeded: what a change under `.beads/` does, and
   * debounced with those changes. Does nothing before the dev server has started or after it closed.
   */
  rebuildSoon(): void;
  /**
   * Settles once the latest dev server's `.beads/` watcher is armed and has
   * compared `.beads/` with what it held before arming: true then; false
   * when there is no `.beads/` to watch, or the server closed first. A
   * change made after it settles is seen by the watcher itself.
   */
  whenWatching(): Promise<boolean>;
}

/**
 * Folders directly under `.beads/` that are neither watched nor listed.
 * - `dolt/`: the embedded Dolt database. Thousands of files that Dolt
 *   rewrites on its own (journal, chunks, garbage collection), and that a
 *   tracker write also announces through `last-touched` or the export.
 * - `backup/`: Dolt backups (`.darc`, a manifest), written on bd's own
 *   schedule after the writes they copy; over 100 MB in a long-lived tracker.
 * The pages are built from `bd export` and `issues.jsonl`, never from these.
 */
const IGNORED_DIRS = new Set(["dolt", "backup"]);

/**
 * Files under `.beads/` that change without a tracker write, each with the
 * reason. The pages show nothing read from any of them.
 */
const IGNORED_FILES: readonly {
  matches: (name: string) => boolean;
  why: string;
}[] = [
  {
    matches: (name) => name.startsWith("dolt-server."),
    why: "the Dolt server's log, pid, port and lock",
  },
  {
    matches: (name) => name.startsWith("bd.sock"),
    why: "the bd daemon's socket and its start lock",
  },
  {
    matches: (name) => name.startsWith("daemon."),
    why: "the bd daemon's lock, log and pid",
  },
  {
    matches: (name) =>
      name === ".exclusive-lock" ||
      name === ".sync.lock" ||
      name.endsWith(".lock"),
    why: "locks every bd command takes and drops",
  },
  {
    matches: (name) => name === "sync-state.json" || name === "push-state.json",
    why: "sync and push bookkeeping, per machine",
  },
  {
    matches: (name) => name === "interactions.jsonl",
    why: "bd's log of agent interactions, which no page reads",
  },
];
// `last-touched` is watched on purpose. Under a shared Dolt server the
// database is not under `.beads/`, and a bd command run in a terminal leaves
// only this file behind: it is how such a write reaches the pages. bd rewrites
// it on reads too (`bd show`), so a read can cost one debounced rebuild. The
// build's own bd call does not rewrite it; were one to, `SELF_TOUCH_GRACE_MS`
// keeps that from starting the next build.
const LAST_TOUCHED = "last-touched";

/** How deep under `.beads/` the watcher and the check look. */
const WATCH_DEPTH = 10;

/**
 * Whether a path under `beadsDir` is left alone by the watcher and by the
 * check made when it is armed: the one rule both use.
 */
export function isIgnoredBeadsPath(beadsDir: string, file: string): boolean {
  const relative = path.relative(beadsDir, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    return false;
  const parts = relative.split(/[\\/]/);
  if (IGNORED_DIRS.has(parts[0] ?? "")) return true;
  const name = parts[parts.length - 1] ?? "";
  return IGNORED_FILES.some((rule) => rule.matches(name));
}

/**
 * Each file under `dir` that the watcher would report, with its size and
 * modification time. Two listings that differ mean a file was added,
 * removed or rewritten between them. A file rewritten with the same size in
 * the same clock tick is not told apart.
 */
export function listWatchedFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (at: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(at, entry.name);
      if (isIgnoredBeadsPath(dir, full)) continue;
      if (entry.isDirectory()) {
        if (depth < WATCH_DEPTH) walk(full, depth + 1);
        continue;
      }
      try {
        const stats = statSync(full);
        files.set(full, `${stats.size}:${stats.mtimeMs}`);
      } catch {
        // Removed while listed: absent, as it is now.
      }
    }
  };
  walk(dir, 0);
  return files;
}

function sameListing(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [file, stamp] of a) if (b.get(file) !== stamp) return false;
  return true;
}

/** One server's `whenWatching` answer, settled once: the first call wins. */
interface WatchingAnswer {
  promise: Promise<boolean>;
  settle(armed: boolean): void;
  settled(): boolean;
}

function watchingAnswer(): WatchingAnswer {
  let settled = false;
  let resolve: (armed: boolean) => void = () => {};
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return {
    promise,
    settle(armed) {
      if (settled) return;
      settled = true;
      resolve(armed);
    },
    settled: () => settled,
  };
}

export function rebuildPagesPlugin(
  options: RebuildPagesOptions,
): Plugin & { api: RebuildPagesApi } {
  const { root } = options;
  const command = options.command ?? {
    file: "bun",
    args: [path.join(root, "scripts", "build-pages.ts")],
  };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  /** Set while the dev server runs. */
  let rebuildSoon: (() => void) | null = null;
  /** The latest server's `whenWatching` answer. */
  let watching = watchingAnswer();
  let configured = false;

  return {
    name: "agent-forge-rebuild-pages",
    // Vite's way for one plugin to call another: the dashboard config hands
    // `rebuildSoon` to the hearth plugin, which calls it after a tracker write.
    api: {
      rebuildSoon() {
        rebuildSoon?.();
      },
      whenWatching() {
        return watching.promise;
      },
    },
    configureServer(server) {
      // Each server has its own answer: a restart configures the next server
      // before this one closes, and that close must not settle the next one's.
      if (configured) watching = watchingAnswer();
      configured = true;
      const thisWatching = watching;
      /** Builds running now, and when the last one ended plus the grace. */
      let building = 0;
      let quietUntil = 0;
      const queue = createRebuildQueue(async () => {
        building++;
        try {
          return await runBuild(command, root, timeoutMs);
        } finally {
          building--;
          quietUntil = Date.now() + SELF_TOUCH_GRACE_MS;
        }
      });
      /**
       * Rebuild, then tell open pages when the build succeeded. Not a full
       * reload: that would discard what a page holds that is not saved (a
       * bead half written in the builder). The page reads the snapshot again.
       */
      const rebuildAndTell = (): void => {
        void queue.request().then((outcome) => {
          if (outcome.ok) server.ws.send(SNAPSHOT_REBUILT_EVENT, {});
        });
      };

      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "").split("?")[0] ?? "";
        if (pathname !== REBUILD_PATH) {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        // Vite may be bound beyond loopback (`DASHBOARD_HOST`); a build is
        // started only for a client on this machine, whatever the method.
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
          res.statusCode = 403;
          res.end(
            JSON.stringify({
              ok: false,
              error: "The rebuild is available only from this machine",
            }),
          );
          return;
        }
        // A page of another site open in this machine's browser is a loopback
        // client too. The hearth's front-door rules tell it apart: Host,
        // Origin and Sec-Fetch-Site each sent at most once, a loopback Host, an
        // Origin (when sent) equal to that host's, and Sec-Fetch-Site (when
        // sent) same-origin or none.
        if (!passesFrontDoor(req)) {
          res.statusCode = 403;
          res.end(
            JSON.stringify({
              ok: false,
              error: "The rebuild is answered only to the dashboard's own page",
            }),
          );
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(
            JSON.stringify({
              ok: false,
              error: "Method not allowed — use POST",
            }),
          );
          return;
        }
        void queue.request().then((outcome) => {
          res.statusCode = outcome.ok ? 200 : 500;
          res.end(
            JSON.stringify(
              outcome.ok ? { ok: true } : { ok: false, error: outcome.output },
            ),
          );
        });
      });

      if (options.initialBuild ?? true) rebuildAndTell();

      // Debounced so a burst of Dolt writes, or of tracker writes, becomes one rebuild.
      let debounce: ReturnType<typeof setTimeout> | null = null;
      const schedule = (): void => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = null;
          rebuildAndTell();
        }, DEBOUNCE_MS);
      };
      rebuildSoon = schedule;

      const beadsDir = path.join(root, ".beads");
      let watcher: ReturnType<typeof chokidar.watch> | null = null;
      let stopped = false;
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        // A restart configures the next server before this one closes.
        if (rebuildSoon === schedule) rebuildSoon = null;
        if (debounce) clearTimeout(debounce);
        thisWatching.settle(false);
        void watcher?.close();
      };
      if (server.httpServer) server.httpServer.on("close", stop);
      else {
        // Middleware mode: no server of Vite's own closes, so its close does.
        const close = server.close.bind(server);
        server.close = async () => {
          stop();
          await close();
        };
      }

      if (!existsSync(beadsDir)) {
        thisWatching.settle(false);
        return;
      }

      // The watcher is armed only after it has read the directory: a file
      // written before then is part of what it starts from (`ignoreInitial`)
      // or is not seen at all. What `.beads/` held before arming is compared
      // with what it holds once armed, and a difference is rebuilt (czqf).
      const before = listWatchedFiles(beadsDir);
      watcher = chokidar.watch(beadsDir, {
        ignoreInitial: true,
        depth: WATCH_DEPTH,
        awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
        // chokidar 4 matches a string here only as an exact path, so the
        // rule is a function: the one the listing uses.
        ignored: (file: string) => isIgnoredBeadsPath(beadsDir, file),
      });

      const changed = (file: string): void => {
        if (
          path.basename(file) === LAST_TOUCHED &&
          (building > 0 || Date.now() < quietUntil)
        )
          return;
        schedule();
      };
      watcher.on("add", changed);
      watcher.on("change", changed);
      watcher.on("unlink", schedule);
      watcher.once("ready", () => {
        if (stopped) return;
        if (!sameListing(before, listWatchedFiles(beadsDir))) schedule();
        thisWatching.settle(true);
      });
      // A directory that cannot be read, or a scan that fails before it is
      // armed: the answer is false rather than never.
      watcher.on("error", () => {
        thisWatching.settle(false);
      });
    },
  };
}
