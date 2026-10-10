/**
 * Dev-only APIs for the Forge run and Repos & knowledge views.
 *
 * Both pages surface state that only exists on the machine running the
 * harness — `.tmp/work/forge-state.json`, the quality-gate log, `trees/`,
 * `repos/`, `knowledge/repos/` — none of which is committed. Like the plans
 * and council plugins they are loopback-only and absent from any static build,
 * where the pages show a "needs the dev server" state instead.
 *
 * The routes served here only read. Recording a checkpoint review — the one
 * write, a `review:` comment in Beads — is an action row of the operator API
 * (`./operator.ts`), which is where its token, audit row and same-origin check
 * are applied; `applyReview` below is its effect.
 */

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { LOG_BASE_DIR } from "../../../.claude/hooks/utils/constants";
import {
  type ForgeRunSnapshot,
  forgeRunSnapshot,
  issueStatusFromBdShow,
  REVIEWABLE_STATUS,
  reviewCommentFor,
} from "../../dashboard/forge-run-model";
import {
  ageInDays,
  buildRepoEntries,
  parseWorktreeState,
  type ReposKnowledge,
  sharedConventionsFrom,
  worktreeViews,
} from "../../dashboard/repos-knowledge-model";
import { runStatePath } from "../../forge/runs";
import { listRuns } from "../../forge/runs-store";

export const DEV_API = "/__agent-forge/dev-api";

/** How many days of the gate log to search for this checkout's latest run. */
const GATE_LOG_DAYS = 31;

/** Loopback guard for the read-only routes — never serve this off-machine. */
export function isLocalRequest(req: IncomingMessage): boolean {
  const remote = req.socket.remoteAddress;
  return (
    remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1"
  );
}

function readIfPresent(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function directoryNames(path: string): string[] {
  try {
    if (!existsSync(path)) return [];
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Knowledge YAML basenames mapped to their age in days. */
export function knowledgeAges(
  knowledgeDir: string,
  now: number,
): Map<string, number | null> {
  const ages = new Map<string, number | null>();
  try {
    if (!existsSync(knowledgeDir)) return ages;
    for (const entry of readdirSync(knowledgeDir)) {
      if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
      const name = entry.replace(/\.(yaml|yml)$/i, "");
      try {
        ages.set(
          name,
          ageInDays(statSync(join(knowledgeDir, entry)).mtimeMs, now),
        );
      } catch {
        ages.set(name, null);
      }
    }
  } catch {
    // An unreadable knowledge directory is simply "no knowledge files".
  }
  return ages;
}

const LINKED_WORKTREE_GITDIR =
  /^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/][^\\/\r\n]+\s*$/m;

/**
 * The checkout that holds the machine-local registries.
 *
 * `repos/`, `knowledge/repos/` and `trees/.state.json` are gitignored, so they
 * exist only in the main checkout. A dashboard started inside a linked
 * worktree — where workers run — would otherwise report no repositories, no
 * knowledge and no worktrees. A linked worktree's `.git` is a file pointing at
 * `<main>/.git/worktrees/<id>` (absolute, or relative since git 2.48); any
 * other root is its own main checkout.
 */
export function localStateRoot(root: string): string {
  try {
    const gitPath = join(root, ".git");
    if (!existsSync(gitPath) || statSync(gitPath).isDirectory()) return root;
    const main = LINKED_WORKTREE_GITDIR.exec(
      readFileSync(gitPath, "utf8"),
    )?.[1];
    if (!main) return root;
    const resolved = resolve(root, main);
    return existsSync(resolved) ? resolved : root;
  } catch {
    return root;
  }
}

/**
 * `quality-gate.jsonl` contents, newest day first.
 *
 * The hook writes one directory per UTC date (`YYYY-MM-DD`), which sorts
 * lexically into date order. A generator, so older days are read only when
 * newer ones hold no run for this checkout.
 */
export function* gateLogsNewestFirst(
  logBase: string = LOG_BASE_DIR,
  maxDays: number = GATE_LOG_DAYS,
): Generator<string> {
  let days: string[];
  try {
    if (!existsSync(logBase)) return;
    days = readdirSync(logBase, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, maxDays);
  } catch {
    return;
  }
  for (const day of days) {
    const log = readIfPresent(join(logBase, day, "quality-gate.jsonl"));
    if (log !== null) yield log;
  }
}

export function readForgeRun(
  root: string,
  logBase: string = LOG_BASE_DIR,
): ForgeRunSnapshot {
  // Forge state stays with the checkout: a run is driven from the worktree it
  // builds in. Gate runs are matched to that checkout and run, because the log
  // they come from is shared by every checkout on the machine. Several runs can
  // be in flight, so every one of them is read — `listRuns` also migrates a
  // legacy single-run state file on the way past.
  return forgeRunSnapshot({
    runStates: listRuns(root).map((run) =>
      readIfPresent(join(root, runStatePath(run.slug) ?? "")),
    ),
    checkout: root,
    gateLogs: gateLogsNewestFirst(logBase),
    artifactExists: (path) => existsSync(join(root, path)),
  });
}

export function readReposKnowledge(
  root: string,
  now: number = Date.now(),
): ReposKnowledge {
  const local = localStateRoot(root);
  // _shared.yaml is committed, so the branch's own copy is the one to show.
  const shared = readIfPresent(join(root, "knowledge", "_shared.yaml"));
  return {
    repos: buildRepoEntries({
      reposJson: readIfPresent(join(local, "repos", "repos.json")),
      clonedDirs: directoryNames(join(local, "repos")),
      knowledge: knowledgeAges(join(local, "knowledge", "repos"), now),
      now,
    }),
    worktrees: worktreeViews(
      parseWorktreeState(readIfPresent(join(local, "trees", ".state.json"))),
      (path) => existsSync(path),
    ),
    conventions:
      shared === null
        ? null
        : sharedConventionsFrom(shared, "knowledge/_shared.yaml"),
    localStateFrom: local === root ? null : local,
  };
}

export interface BdResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs `bd` with an argument array — never a shell — and reports how it went.
 * `timeoutMs` is how long this call may run before it is killed; without it
 * the runner's own limit applies.
 */
export type BdRunner = (
  args: string[],
  options?: { timeoutMs?: number },
) => BdResult | Promise<BdResult>;

export interface ApiReply {
  status: number;
  body: { ok: boolean; data: unknown; error: string | null };
}

const fail = (status: number, error: string): ApiReply => ({
  status,
  body: { ok: false, data: null, error },
});

function failureReason(result: BdResult): string {
  return result.stderr.trim().slice(0, 500) || `exit ${result.status}`;
}

/**
 * Record a checkpoint review.
 *
 * `bd` is invoked with argument arrays — never a shell — and the id and
 * comment are validated first, so nothing in the request is interpreted.
 */
export async function applyReview(
  input: unknown,
  runBd: BdRunner,
): Promise<ApiReply> {
  const review = reviewCommentFor(input);
  if (!review.ok) return fail(400, review.error);

  // The page may be rendering a stale snapshot, so Beads decides: only a
  // checkpoint that is in progress right now has work to approve.
  const shown = await runBd(["show", review.issueId, "--json"]);
  if (shown.status !== 0) {
    return fail(502, `bd show failed: ${failureReason(shown)}`);
  }
  const status = issueStatusFromBdShow(shown.stdout);
  if (status !== REVIEWABLE_STATUS) {
    return fail(
      409,
      `Only an in-progress checkpoint can be reviewed; ${review.issueId} is ${status ?? "of unknown status"} in Beads`,
    );
  }

  const added = await runBd(["comments", "add", review.issueId, review.body]);
  if (added.status !== 0) {
    return fail(502, `bd comments add failed: ${failureReason(added)}`);
  }
  return {
    status: 200,
    body: {
      ok: true,
      data: { issueId: review.issueId, comment: review.body },
      error: null,
    },
  };
}

/** How long one `bd` call may run, and how much it may print, before it is given up on. */
const BD_TIMEOUT_MS = 30_000;
const BD_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * The real `bd`, run from `root`: an argument array, no shell, and not on the
 * serving thread — a slow tracker must not stall every other request and every
 * open stream. A call that cannot start, times out or prints too much resolves
 * with a null or non-zero status and the reason on stderr; it never rejects.
 */
export function bdRunner(root: string): BdRunner {
  return (args, options) =>
    new Promise<BdResult>((done) => {
      execFile(
        "bd",
        args,
        {
          cwd: root,
          encoding: "utf8",
          shell: false,
          timeout: options?.timeoutMs ?? BD_TIMEOUT_MS,
          maxBuffer: BD_MAX_OUTPUT_BYTES,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : error.code;
          done({
            status: typeof code === "number" ? code : null,
            stdout: String(stdout ?? ""),
            stderr: String(stderr || error?.message || ""),
          });
        },
      );
    });
}

function sendJson(res: ServerResponse, reply: ApiReply): void {
  res.statusCode = reply.status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(reply.body));
}

export async function devApiHttpHandler(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): Promise<void> {
  const pathname = (req.url ?? "").split("?")[0] ?? "";
  if (!pathname.startsWith(`${DEV_API}/`)) {
    next();
    return;
  }
  const route = pathname.slice(DEV_API.length);

  if (route === "/forge-run/review") {
    // The POST is an operator action and never reaches this handler through a
    // hearth. Whatever does reach it gets the answer every other method always
    // got here, and nothing is written.
    sendJson(res, fail(405, "Method not allowed"));
    return;
  }

  if (!isLocalRequest(req)) {
    sendJson(
      res,
      fail(403, "This API is available only from the local dashboard"),
    );
    return;
  }
  if (req.method !== "GET") {
    sendJson(res, fail(405, "Method not allowed"));
    return;
  }
  if (route === "/forge-run") {
    sendJson(res, {
      status: 200,
      body: { ok: true, data: readForgeRun(root), error: null },
    });
    return;
  }
  if (route === "/repos-knowledge") {
    sendJson(res, {
      status: 200,
      body: { ok: true, data: readReposKnowledge(root), error: null },
    });
    return;
  }
  sendJson(res, fail(404, "Unknown dev API route"));
}
