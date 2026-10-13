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
 * Loaded by Vite under Node: imports nothing from Bun.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import type { Plugin } from "vite";
import { isLoopbackAddress } from "../hearth/gate";
import { createRebuildQueue, type RebuildOutcome } from "./rebuild-queue";

export const REBUILD_PATH = "/__agent-forge/rebuild-pages";

/** A build that takes longer is stopped and reported as failed. */
const DEFAULT_TIMEOUT_MS = 180_000;
/** How much of a build's output is kept for an error answer. */
const OUTPUT_MAX = 8000;
/** How long a requested rebuild waits for more requests to join it. */
const DEBOUNCE_MS = 700;

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
   * Rebuild after a short pause, then tell the page to reload when the build
   * succeeded: what a change under `.beads/` does, and debounced with those
   * changes. Does nothing before the dev server has started or after it closed.
   */
  rebuildSoon(): void;
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

  return {
    name: "agent-forge-rebuild-pages",
    // Vite's way for one plugin to call another: the dashboard config hands
    // `rebuildSoon` to the hearth plugin, which calls it after a tracker write.
    api: {
      rebuildSoon() {
        rebuildSoon?.();
      },
    },
    configureServer(server) {
      const queue = createRebuildQueue(() =>
        runBuild(command, root, timeoutMs),
      );
      /** Rebuild, then reload the page when the build succeeded. */
      const rebuildAndReload = (): void => {
        void queue.request().then((outcome) => {
          if (outcome.ok) server.ws.send({ type: "full-reload", path: "*" });
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

      if (options.initialBuild ?? true) rebuildAndReload();

      // Debounced so a burst of Dolt writes, or of tracker writes, becomes one rebuild.
      let debounce: ReturnType<typeof setTimeout> | null = null;
      const schedule = (): void => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = null;
          rebuildAndReload();
        }, DEBOUNCE_MS);
      };
      rebuildSoon = schedule;
      server.httpServer?.on("close", () => {
        // A restart configures the next server before this one closes.
        if (rebuildSoon === schedule) rebuildSoon = null;
        if (debounce) clearTimeout(debounce);
      });

      const beadsDir = path.join(root, ".beads");
      if (!existsSync(beadsDir)) return;

      const watcher = chokidar.watch(beadsDir, {
        ignoreInitial: true,
        depth: 10,
        awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
        ignored: [
          "**/dolt-server.log",
          "**/dolt-server.pid",
          "**/dolt-server.port",
          "**/bd.sock*",
          "**/.exclusive-lock",
          "**/sync-state.json",
          "**/push-state.json",
          "**/interactions.jsonl",
          "**/last-touched",
        ],
      });

      watcher.on("add", schedule);
      watcher.on("change", schedule);
      watcher.on("unlink", schedule);

      server.httpServer?.on("close", () => {
        void watcher.close();
      });
    },
  };
}
