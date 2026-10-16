/**
 * A hermetic hearth for tests: its own home, ledger, root and `bd`.
 *
 * Nothing here reaches the real tracker, the real ledger or the user's config:
 * the root is a temp directory with a planted `.git` (so the ledger's workspace
 * is that directory, not whatever checkout the OS temp directory sits in), the
 * `bd` runner is a recorder, the council's command runner is a recorder that
 * refuses what its test did not arrange, the shift launcher records what
 * `POST /shifts` would start and starts nothing, and the machine config is
 * read from a temp home.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LedgerEvent, LedgerEventInput } from "../../types/hearth";
import { operatorCouncilLedger } from "../council/ledger-wiring";
import type { CommandRunner } from "../council/pr-source";
import { appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { queryEvents } from "../ledger/query";
import { resolveCheckout } from "../ledger/workspace";
import { childOf } from "../scheduler/queue-fixture";
import { type BdIssue, bdAnswers, bdTime, readWrite } from "./bd-answers";
import {
  LAUNCH_HEADER,
  LAUNCH_ROUTE,
  OPERATOR_HEADER,
  SESSION_ROUTE,
  SURFACE_HEADER,
} from "./paths";
import type { BdResult } from "./routes/dev-api";
import {
  createHearth,
  type OperatorApiOverrides,
  type StartedHearth,
} from "./server";
import type {
  ShiftChildExit,
  ShiftLauncher,
  ShiftLaunchSpec,
} from "./shift-launcher";

const REPO = resolve(import.meta.dir, "..", "..");

/** A stand-in for `bd` that records every argument array it is called with. */
export interface FakeBd {
  calls: string[][];
  /** The options each call was given, in the same order as `calls`. */
  options: Array<{ timeoutMs?: number } | undefined>;
  /** What `bd list` prints; replace to change the queue. */
  list: BdResult | (() => Promise<BdResult>);
  /** The status `bd show` reports for any issue. */
  status: string;
  /**
   * Answer a call yourself: return a result to use it, or nothing to let the
   * fake answer. For what a real `bd` does that the fake does not: a refusal,
   * a call that never finishes, help text, an id it resolved differently.
   */
  answer: ((args: string[]) => BdResult | Promise<BdResult> | undefined) | null;
  /** The issues the fake's own answers to the write routes have described, by id. */
  issues: Map<string, BdIssue>;
  run(args: string[], options?: { timeoutMs?: number }): Promise<BdResult>;
}

/**
 * What the fake answers to a write the Beads routes make (`--json`), in bd's
 * own shapes. It records and agrees; it does not refuse what bd would refuse
 * (an unknown parent, a closed issue): a test that needs a refusal sets
 * `answer`. A create under a parent the fake knows (in `issues`) copies the
 * parent's labels onto the child and none of its metadata, as
 * `bd create --parent` does (`childOf`); under a parent it does not know,
 * the child has no labels.
 */
function answerWrite(bd: FakeBd, args: string[]): BdResult | null {
  const write = readWrite(args);
  if (write === null) return null;
  const now = bdTime();
  if (write.verb === "create") {
    const siblings = [...bd.issues.keys()].filter((id) =>
      write.parent === undefined
        ? !id.includes(".")
        : id.startsWith(`${write.parent}.`),
    ).length;
    const id =
      write.parent === undefined
        ? `made-${siblings + 1}`
        : `${write.parent}.${siblings + 1}`;
    const parent =
      write.parent === undefined ? undefined : bd.issues.get(write.parent);
    const inherited =
      parent === undefined
        ? undefined
        : childOf(
            {
              id: parent.id,
              ...(parent.labels !== undefined ? { labels: parent.labels } : {}),
              ...(parent.metadata !== undefined
                ? { metadata: parent.metadata }
                : {}),
            },
            id,
          ).labels;
    const issue: BdIssue = {
      id,
      title: write.title,
      issue_type: write.type,
      priority: Number(write.priority),
      status: "open",
      ...(write.description !== undefined
        ? { description: write.description }
        : {}),
      ...(inherited !== undefined ? { labels: [...inherited].sort() } : {}),
      created_at: now,
      updated_at: now,
    };
    bd.issues.set(issue.id, issue);
    return bdAnswers.created(issue);
  }
  if (write.verb === "comment")
    return bdAnswers.commented({
      id: `comment-${bd.calls.length}`,
      issueId: write.id,
      author: "operator",
      text: write.text,
      // bd times a comment to a fraction of a second, an issue to the second.
      createdAt: new Date().toISOString(),
    });
  const known: BdIssue = bd.issues.get(write.id) ?? {
    id: write.id,
    title: "",
    issue_type: "task",
    priority: 2,
    status: "open",
    created_at: now,
    updated_at: now,
  };
  const issue: BdIssue =
    write.verb === "claim"
      ? {
          ...known,
          status: "in_progress",
          assignee: "operator",
          updated_at: now,
        }
      : {
          ...known,
          status: "closed",
          close_reason: write.reason,
          closed_at: now,
          updated_at: now,
        };
  bd.issues.set(issue.id, issue);
  return write.verb === "claim"
    ? bdAnswers.claimed(issue)
    : bdAnswers.closed(issue);
}

export function fakeBd(): FakeBd {
  const bd: FakeBd = {
    calls: [],
    list: { status: 0, stdout: "[]", stderr: "" },
    status: "in_progress",
    options: [],
    answer: null,
    issues: new Map(),
    async run(args, options) {
      bd.calls.push(args);
      bd.options.push(options);
      const given = await bd.answer?.(args);
      if (given !== undefined) return given;
      if (args[0] === "list")
        return typeof bd.list === "function" ? bd.list() : bd.list;
      if (args[0] === "show")
        return {
          status: 0,
          stdout: JSON.stringify([{ id: args[1], status: bd.status }]),
          stderr: "",
        };
      return answerWrite(bd, args) ?? { status: 0, stdout: "", stderr: "" };
    },
  };
  return bd;
}

/**
 * The council's command runner in a test hearth: it records every command and
 * where it was asked to run it, answers with `answer` when that returns a
 * result, and refuses everything else, so no test starts a real `bd`, `git`
 * or `gh` through the council by accident.
 */
export interface FakeCommands {
  calls: Array<{ command: string[]; cwd: string }>;
  answer: CommandRunner | null;
  run: CommandRunner;
}

export function fakeCommands(): FakeCommands {
  const commands: FakeCommands = {
    calls: [],
    answer: null,
    async run(command, cwd) {
      commands.calls.push({ command: [...command], cwd });
      const given = await commands.answer?.(command, cwd);
      return (
        given ?? {
          exitCode: 127,
          stdout: "",
          stderr: "the test hearth runs no command its test did not arrange",
        }
      );
    },
  };
  return commands;
}

/** A child the test hearth's stand-in launcher "started": nothing runs. */
export interface FakeShiftChild {
  spec: ShiftLaunchSpec;
  pid: number;
  /** Whether the hearth ended it (`stop()`, at its close). */
  stopped: boolean;
  /** Let it exit, as a shift would, with this exit code and what it printed. */
  exit(exit?: Partial<ShiftChildExit>): void;
  /** Settles when it has exited. */
  done: Promise<ShiftChildExit>;
}

/**
 * The test hearth's shift launcher: it records what it was asked to start and
 * starts nothing, so no test hearth runs `forge:shift` (whose real
 * dependencies run `bd` in the main checkout and `git fetch` against origin).
 * Its children run until the test lets them exit or the hearth ends them.
 * Its ids are minted in order, so a test knows the id a start will name.
 */
export interface FakeShifts {
  launches: FakeShiftChild[];
  /** Called with each child as it is started; a throw is a child that could not be started. */
  onLaunch: ((child: FakeShiftChild) => void) | null;
  launch: ShiftLauncher;
  /** The ids minted so far, in order. */
  minted: string[];
  /** The id the next mint gives. */
  next(): string;
  mint(): string;
}

/** No process has an id this large on the platforms the harness runs on. */
const FAKE_PID = 2_000_000_000;

export function fakeShifts(): FakeShifts {
  const shifts: FakeShifts = {
    launches: [],
    onLaunch: null,
    minted: [],
    next: () =>
      `shift-20261015-120000-${(shifts.minted.length + 1).toString(16).padStart(4, "0")}`,
    mint() {
      const id = shifts.next();
      shifts.minted.push(id);
      return id;
    },
    launch(spec) {
      let finish = (_exit: ShiftChildExit): void => undefined;
      const done = new Promise<ShiftChildExit>((settle) => {
        finish = settle;
      });
      let exited = false;
      const end = (exit: ShiftChildExit): void => {
        if (exited) return;
        exited = true;
        finish(exit);
      };
      const child: FakeShiftChild = {
        spec,
        pid: FAKE_PID + shifts.launches.length,
        stopped: false,
        done,
        exit: (exit = {}) =>
          end({ exitCode: 1, stdout: "", stderr: "", ...exit }),
      };
      shifts.onLaunch?.(child);
      shifts.launches.push(child);
      return {
        pid: child.pid,
        done,
        stop: async () => {
          child.stopped = true;
          end({ exitCode: null, stdout: "", stderr: "" });
          await done;
        },
      };
    },
  };
  return shifts;
}

export interface TestHearth {
  hearth: StartedHearth;
  /** `http://127.0.0.1:<port>/__agent-forge` */
  api: string;
  home: string;
  root: string;
  /** With `linkedWorktree`, the main checkout `root` is a worktree of. */
  main?: string;
  /** What the council's bead and pr sources run through this hearth. */
  commands: FakeCommands;
  /** Stands in for the OS home: the machine config is read from `.agent-forge/config.toml` under it. */
  configHome: string;
  /** The ledger's name for `root`. */
  workspace: string;
  ledger: string;
  bd: FakeBd;
  /** What `POST /shifts` started, unless the test handed the hearth a launcher of its own. */
  shifts: FakeShifts;
  /** Headers of a same-origin request, with the operator token when asked. */
  headers(token?: string | null): Record<string, string>;
  /** Append to this hearth's ledger, as another emitter would. */
  append(event: Omit<LedgerEventInput, "workspace">): number;
  events(kinds?: LedgerEvent["kind"][]): LedgerEvent[];
  close(): Promise<void>;
}

export interface TestHearthOptions {
  api?: OperatorApiOverrides;
  /** Hand the hearth a council ledger (this hearth's own), as `main()` does. Off by default. */
  councilRuns?: boolean;
  /** Files to write under the root before the hearth starts. */
  files?: Record<string, string>;
  /**
   * Make the root a linked worktree of another temp directory, laid out as git
   * lays one out (a `.git` file naming `<main>/.git/worktrees/<id>`).
   */
  linkedWorktree?: boolean;
  /** The clock launch secrets and sessions are timed by (`HearthOptions.launchNow`). */
  launchNow?: () => number;
}

export async function startTestHearth(
  options: TestHearthOptions = {},
): Promise<TestHearth> {
  const home = mkdtempSync(join(tmpdir(), "af-api-home-"));
  const root = mkdtempSync(join(tmpdir(), "af-api-root-"));
  const configHome = mkdtempSync(join(tmpdir(), "af-api-user-"));
  let main: string | undefined;
  if (options.linkedWorktree) {
    main = mkdtempSync(join(tmpdir(), "af-api-main-"));
    const gitDir = join(main, ".git", "worktrees", "tree");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    writeFileSync(join(root, ".git"), `gitdir: ${gitDir}\n`);
  } else mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".tmp", "work"), { recursive: true });
  for (const [relative, content] of Object.entries(options.files ?? {})) {
    const file = join(root, relative);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  }
  const ledger = join(home, "ledger.db");
  const bd = fakeBd();
  const commands = fakeCommands();
  const shifts = fakeShifts();
  const hearth = await createHearth({
    root,
    home,
    harnessRoot: REPO,
    environment: { COUNCIL_RUNS_DIR: join(root, "council-runs") },
    ...(options.councilRuns
      ? { councilLedger: operatorCouncilLedger({ path: ledger }) }
      : {}),
    councilRunCommand: commands.run,
    ...(options.launchNow ? { launchNow: options.launchNow } : {}),
    api: {
      ledgerPath: ledger,
      runBd: (args, options) => bd.run(args, options),
      configHome,
      launchShift: shifts.launch,
      mintShiftId: () => shifts.mint(),
      // Its children never stop on their own; a test that waits on a close sets its own.
      shiftStopGraceMs: 200,
      ...options.api,
    },
  });
  if (hearth.kind !== "started") throw new Error("expected a fresh hearth");
  const workspace = resolveCheckout(root).workspace;
  return {
    hearth,
    api: `${hearth.url}/__agent-forge`,
    home,
    root,
    ...(main !== undefined ? { main } : {}),
    commands,
    configHome,
    workspace,
    ledger,
    bd,
    shifts,
    headers(token) {
      return {
        Origin: hearth.url,
        "Content-Type": "application/json",
        ...(token ? { [OPERATOR_HEADER]: token } : {}),
      };
    },
    append(event) {
      // justification: the caller's kind and payload stay paired; only the workspace is added.
      const result = appendEvent({ ...event, workspace } as LedgerEventInput, {
        path: ledger,
      });
      if (!result.ok || !("id" in result))
        throw new Error("the test event was not stored");
      return result.id;
    },
    events(kinds) {
      return queryEvents(
        { workspace, ...(kinds ? { kinds } : {}) },
        { path: ledger },
      );
    },
    async close() {
      await hearth.close();
      closeLedger(ledger);
      for (const dir of [home, root, configHome, ...(main ? [main] : [])])
        rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** One server-sent event, or a `: …` comment line. */
export interface StreamMessage {
  /** `snapshot`, `delta`, or `comment` for a `: …` line. */
  event: string;
  id?: string;
  data: string;
}

export interface StreamClient {
  response: Response;
  /** The next message, or null when the stream ended. Rejects after `withinMs`. */
  next(withinMs?: number): Promise<StreamMessage | null>;
  /** True when nothing arrives for `ms`. */
  quiet(ms: number): Promise<boolean>;
  close(): void;
}

/**
 * Read server-sent events as they arrive, one message at a time: the body is
 * read chunk by chunk, so a test sees a message when it is sent, not when the
 * stream ends. The comment a ledger stream opens with (`: open`) is not
 * passed on. The caller closes the client.
 */
export async function openEventStream(
  url: string,
  headers: Record<string, string>,
): Promise<StreamClient> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  const ready: Array<StreamMessage | null> = [];
  let buffer = "";
  let pending: Promise<void> | null = null;

  const pump = async (): Promise<void> => {
    if (!reader) {
      ready.push(null);
      return;
    }
    const { value, done } = await reader.read();
    if (done) {
      ready.push(null);
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end === -1) break;
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const message: StreamMessage = { event: "message", data: "" };
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) {
          message.event = "comment";
          message.data = line.slice(1).trim();
        } else if (line.startsWith("event: ")) message.event = line.slice(7);
        else if (line.startsWith("id: ")) message.id = line.slice(4);
        else if (line.startsWith("data: ")) message.data += line.slice(6);
      }
      // The ledger stream's first bytes (`stream.ts`): they say the stream is
      // open, which `response` already shows, and are not a message to read.
      if (message.event === "comment" && message.data === "open") continue;
      ready.push(message);
    }
  };
  const fill = (): Promise<void> => {
    pending ??= pump()
      .catch(() => {
        ready.push(null);
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  const timeout = (ms: number): Promise<"timeout"> =>
    new Promise((done) => setTimeout(() => done("timeout"), ms));

  const client: StreamClient = {
    response,
    async next(withinMs = 5000) {
      const deadline = performance.now() + withinMs;
      while (ready.length === 0) {
        const left = deadline - performance.now();
        if (
          left <= 0 ||
          (await Promise.race([fill(), timeout(left)])) === "timeout"
        )
          throw new Error(`no stream message within ${withinMs} ms`);
      }
      return ready.shift() ?? null;
    },
    async quiet(ms) {
      if (ready.length > 0) return false;
      await Promise.race([fill(), timeout(ms)]);
      return ready.length === 0;
    },
    close: () => controller.abort(),
  };
  return client;
}

/** An answer of the control plane: its status, its envelope and its `Set-Cookie`. */
export interface LaunchAnswer {
  status: number;
  body: {
    ok: boolean;
    data: Record<string, unknown> | null;
    error: string | null;
  };
  setCookie: string | null;
}

async function launchAnswer(response: Response): Promise<LaunchAnswer> {
  return {
    status: response.status,
    body: (await response.json()) as LaunchAnswer["body"],
    setCookie: response.headers.get("set-cookie"),
  };
}

/**
 * `POST /launch` at `base` (the hearth's or the dashboard's origin) with the
 * operator token, as the launcher does. `headers` replace the defaults.
 */
export async function mintLaunch(
  base: string,
  token: string | null,
  headers: Record<string, string> = {},
): Promise<LaunchAnswer> {
  return launchAnswer(
    await fetch(`${base}${LAUNCH_ROUTE}`, {
      method: "POST",
      headers: {
        ...(token !== null ? { [OPERATOR_HEADER]: token } : {}),
        [SURFACE_HEADER]: "cli",
        ...headers,
      },
    }),
  );
}

/**
 * `POST /session` at `base` with `secret`, as the page does: declaring `base`
 * as its origin unless `headers` say otherwise.
 */
export async function exchangeLaunch(
  base: string,
  secret: string,
  headers: Record<string, string> = { Origin: base },
): Promise<LaunchAnswer> {
  return launchAnswer(
    await fetch(`${base}${SESSION_ROUTE}`, {
      method: "POST",
      headers: { [LAUNCH_HEADER]: secret, [SURFACE_HEADER]: "ui", ...headers },
    }),
  );
}

/** The `name=value` pair a `Set-Cookie` value sets: what a browser sends back. */
export function cookiePair(setCookie: string | null): string {
  const pair = (setCookie ?? "").split(";")[0] ?? "";
  if (!pair.includes("=")) throw new Error("no cookie was set");
  return pair;
}

/**
 * A dashboard session at `base`, the whole flow a page goes through: a launch
 * secret minted with `token`, exchanged as the page does. The `Cookie` header
 * that carries it.
 */
export async function dashboardSession(
  base: string,
  token: string,
): Promise<string> {
  const minted = await mintLaunch(base, token);
  const secret = minted.body.data?.["secret"];
  if (minted.status !== 200 || typeof secret !== "string")
    throw new Error(`no launch secret was minted (${minted.status})`);
  const exchanged = await exchangeLaunch(base, secret);
  if (exchanged.status !== 200)
    throw new Error(
      `the launch secret was not exchanged (${exchanged.status})`,
    );
  return cookiePair(exchanged.setCookie);
}

/**
 * This process's environment with every proxy setting taken out, then
 * `HTTP_PROXY` (in both spellings) naming a loopback port that nothing listens
 * on, and no `NO_PROXY`. Bun reads these when a process starts, so it is an
 * environment for a child process.
 */
export async function deadProxyEnvironment(): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !/proxy/i.test(name)) env[name] = value;
  const probe = createNetServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  const proxy = `http://127.0.0.1:${port}`;
  return { ...env, HTTP_PROXY: proxy, http_proxy: proxy };
}
