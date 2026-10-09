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
import { appendEvent } from "../ledger/append";
import { closeLedger } from "../ledger/db";
import { queryEvents } from "../ledger/query";
import { resolveCheckout } from "../ledger/workspace";
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
  /** What `bd list` prints; replace to change the queue. */
  list: BdResult | (() => Promise<BdResult>);
  /** The status `bd show` reports for any issue. */
  status: string;
  run(args: string[]): Promise<BdResult>;
}

export function fakeBd(): FakeBd {
  const bd: FakeBd = {
    calls: [],
    list: { status: 0, stdout: "[]", stderr: "" },
    status: "in_progress",
    async run(args) {
      bd.calls.push(args);
      if (args[0] === "list")
        return typeof bd.list === "function" ? bd.list() : bd.list;
      if (args[0] === "show")
        return {
          status: 0,
          stdout: JSON.stringify([{ id: args[1], status: bd.status }]),
          stderr: "",
        };
      return { status: 0, stdout: "", stderr: "" };
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
    api: {
      ledgerPath: ledger,
      runBd: (args) => bd.run(args),
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
