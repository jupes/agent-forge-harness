/**
 * A hermetic hearth for tests: its own home, ledger, root and `bd`.
 *
 * Nothing here reaches the real tracker, the real ledger or the user's config:
 * the root is a temp directory with a planted `.git` (so the ledger's workspace
 * is that directory, not whatever checkout the OS temp directory sits in), the
 * `bd` runner is a recorder, and the machine config is read from a temp home.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LedgerEvent, LedgerEventInput } from "../../types/hearth";
import { operatorCouncilLedger } from "../council/ledger-wiring";
import { appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { queryEvents } from "../ledger/query";
import { resolveCheckout } from "../ledger/workspace";
import { type BdIssue, bdAnswers, bdTime, readWrite } from "./bd-answers";
import { OPERATOR_HEADER } from "./paths";
import type { BdResult } from "./routes/dev-api";
import {
  createHearth,
  type OperatorApiOverrides,
  type StartedHearth,
} from "./server";

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
 * `answer`.
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
    const issue: BdIssue = {
      id:
        write.parent === undefined
          ? `made-${siblings + 1}`
          : `${write.parent}.${siblings + 1}`,
      title: write.title,
      issue_type: write.type,
      priority: Number(write.priority),
      status: "open",
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

export interface TestHearth {
  hearth: StartedHearth;
  /** `http://127.0.0.1:<port>/__agent-forge` */
  api: string;
  home: string;
  root: string;
  /** Stands in for the OS home: the machine config is read from `.agent-forge/config.toml` under it. */
  configHome: string;
  /** The ledger's name for `root`. */
  workspace: string;
  ledger: string;
  bd: FakeBd;
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
}

export async function startTestHearth(
  options: TestHearthOptions = {},
): Promise<TestHearth> {
  const home = mkdtempSync(join(tmpdir(), "af-api-home-"));
  const root = mkdtempSync(join(tmpdir(), "af-api-root-"));
  const configHome = mkdtempSync(join(tmpdir(), "af-api-user-"));
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, ".tmp", "work"), { recursive: true });
  for (const [relative, content] of Object.entries(options.files ?? {})) {
    const file = join(root, relative);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  }
  const ledger = join(home, "ledger.db");
  const bd = fakeBd();
  const hearth = await createHearth({
    root,
    home,
    harnessRoot: REPO,
    environment: { COUNCIL_RUNS_DIR: join(root, "council-runs") },
    ...(options.councilRuns
      ? { councilLedger: operatorCouncilLedger({ path: ledger }) }
      : {}),
    api: {
      ledgerPath: ledger,
      runBd: (args, options) => bd.run(args, options),
      configHome,
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
    configHome,
    workspace,
    ledger,
    bd,
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
      for (const dir of [home, root, configHome])
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
 * stream ends. The caller closes the client.
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
