#!/usr/bin/env bun
/**
 * audit-cli.ts — read the ledger.
 *
 * CLI:
 *   bun run forge:audit --bead <id> [--bead-exact]   # a bead, plus the other events of sessions that touched it
 *   bun run forge:audit --run <slug>                 # one Forge run
 *   bun run forge:audit --session <id>               # one session
 *   bun run forge:audit --since <iso> --kind <k>[,<k>]
 *   bun run forge:audit --limit <n> [--after-id <n>] # newest n, or the n after a cursor (default limit 500)
 *   bun run forge:audit --all-workspaces             # default scope is the checkout of the current directory
 *   bun run forge:audit --json                       # { ok, data, error } instead of a table
 *   bun run forge:audit --backup                     # snapshot to backups/, prune snapshots past 14 days
 *   bun run forge:audit --compact                    # fold events past 90 days into daily counts
 *
 * Filters combine (AND). Exit code 0 when ok; on any error the envelope is
 * printed (with or without --json) and the exit code is 2.
 *
 * When more events match than the limit, the result is cut and one line on
 * stderr says so, with and without --json. The note is not a field of the
 * envelope: `data` stays the array of events its readers parse, and stdout
 * stays the envelope alone.
 */

import {
  LEDGER_EVENT_KINDS,
  type LedgerEvent,
  type LedgerEventKind,
  type OperatorEnvelope,
} from "../../types/hearth";
import { backupLedger, compact } from "./backup";
import { ledgerPath } from "./paths";
import { type EventFilter, queryEventPage } from "./query";
import { resolveCheckout } from "./workspace";

export const DEFAULT_LIMIT = 500;

export interface AuditArgs {
  command: "query" | "backup" | "compact";
  json: boolean;
  allWorkspaces: boolean;
  /** Without `workspace`: the scope is decided when the query runs. */
  filter: Omit<EventFilter, "workspace">;
}

export type ParsedArgs =
  | { ok: true; value: AuditArgs }
  | { ok: false; error: string };

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const VALUE_FLAGS = [
  "--bead",
  "--run",
  "--session",
  "--since",
  "--kind",
  "--limit",
  "--after-id",
] as const;
const SWITCHES = [
  "--bead-exact",
  "--all-workspaces",
  "--json",
  "--backup",
  "--compact",
] as const;

type ValueFlag = (typeof VALUE_FLAGS)[number];
type Switch = (typeof SWITCHES)[number];

function isValueFlag(arg: string): arg is ValueFlag {
  return (VALUE_FLAGS as readonly string[]).includes(arg);
}

function isSwitch(arg: string): arg is Switch {
  return (SWITCHES as readonly string[]).includes(arg);
}

function isKind(value: string): value is LedgerEventKind {
  return (LEDGER_EVENT_KINDS as readonly string[]).includes(value);
}

function fail(error: string): ParsedArgs {
  return { ok: false, error };
}

/** Read the flags into a query, or say which one is wrong. */
export function parseAuditArgs(argv: readonly string[]): ParsedArgs {
  const values = new Map<ValueFlag, string>();
  const switches = new Set<Switch>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (isSwitch(arg)) {
      switches.add(arg);
    } else if (isValueFlag(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--"))
        return fail(`${arg} needs a value`);
      values.set(arg, value);
      i++;
    } else if (arg.startsWith("--")) {
      return fail(`unknown flag: ${arg}`);
    } else {
      return fail(`unexpected argument: ${arg}`);
    }
  }

  const json = switches.has("--json");
  const upkeep = (["--backup", "--compact"] as const).filter((flag) =>
    switches.has(flag),
  );
  if (upkeep.length > 0) {
    const first = upkeep[0];
    if (upkeep.length > 1 || values.size > 0 || switches.size > (json ? 2 : 1))
      return fail(`${first} takes no other flag than --json`);
    return {
      ok: true,
      value: {
        command: first === "--backup" ? "backup" : "compact",
        json,
        allWorkspaces: false,
        filter: {},
      },
    };
  }

  const filter: Omit<EventFilter, "workspace"> = {};
  const bead = values.get("--bead");
  if (bead !== undefined) filter.beadId = bead;
  if (switches.has("--bead-exact")) {
    if (bead === undefined) return fail("--bead-exact needs --bead");
    filter.beadExact = true;
  }
  const run = values.get("--run");
  if (run !== undefined) filter.runId = run;
  const session = values.get("--session");
  if (session !== undefined) filter.sessionId = session;

  const since = values.get("--since");
  if (since !== undefined) {
    if (!ISO_8601.test(since) || Number.isNaN(Date.parse(since)))
      return fail(
        `--since: expected an ISO 8601 timestamp such as 2026-10-07T00:00:00Z, got "${since}"`,
      );
    filter.since = since;
  }

  const kind = values.get("--kind");
  if (kind !== undefined) {
    const kinds: LedgerEventKind[] = [];
    for (const name of kind.split(",").map((part) => part.trim())) {
      if (!isKind(name))
        return fail(
          `--kind: unknown kind "${name}" (one of ${LEDGER_EVENT_KINDS.join(", ")})`,
        );
      kinds.push(name);
    }
    filter.kinds = kinds;
  }

  const limit = values.get("--limit");
  if (limit !== undefined) {
    if (!/^\d+$/.test(limit) || Number(limit) < 1)
      return fail(`--limit: expected a positive integer, got "${limit}"`);
    filter.limit = Number(limit);
  }
  const afterId = values.get("--after-id");
  if (afterId !== undefined) {
    if (!/^\d+$/.test(afterId))
      return fail(
        `--after-id: expected a non-negative integer, got "${afterId}"`,
      );
    filter.afterId = Number(afterId);
  }

  return {
    ok: true,
    value: {
      command: "query",
      json,
      allWorkspaces: switches.has("--all-workspaces"),
      filter,
    },
  };
}

const COLUMNS: ReadonlyArray<[string, (event: LedgerEvent) => string]> = [
  ["id", (event) => String(event.id)],
  ["ts", (event) => event.ts],
  ["kind", (event) => event.kind],
  ["session", (event) => event.sessionId ?? "-"],
  ["bead", (event) => event.beadId ?? "-"],
  ["run", (event) => event.runId ?? "-"],
  ["model", (event) => event.executor?.model ?? "-"],
];

/** The default view: one aligned line per event. */
export function formatTable(events: readonly LedgerEvent[]): string {
  if (events.length === 0) return "no events";
  const rows = [
    COLUMNS.map(([title]) => title),
    ...events.map((event) => COLUMNS.map(([, cell]) => cell(event))),
  ];
  const widths = COLUMNS.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export interface AuditOutcome {
  code: 0 | 2;
  stdout: string;
  /** A note for the reader that is not part of the answer: the result was cut at the limit. */
  stderr?: string;
}

function failure(error: string): AuditOutcome {
  const envelope: OperatorEnvelope = { ok: false, data: null, error };
  return { code: 2, stdout: JSON.stringify(envelope) };
}

function success(data: unknown, json: boolean, text: string): AuditOutcome {
  const envelope: OperatorEnvelope = { ok: true, data, error: null };
  return { code: 0, stdout: json ? JSON.stringify(envelope) : text };
}

/** Run the CLI for an argv, a working directory and an environment. Never throws. */
export function runAudit(
  argv: readonly string[],
  context: { cwd: string; env: Readonly<Record<string, string | undefined>> },
): AuditOutcome {
  const parsed = parseAuditArgs(argv);
  if (!parsed.ok) return failure(parsed.error);
  const { command, json, allWorkspaces, filter } = parsed.value;
  const path = ledgerPath(context.env);
  try {
    if (command === "backup") {
      const result = backupLedger({ path });
      return success(
        result,
        json,
        `backup written to ${result.path} (${result.pruned.length} old snapshot(s) pruned)`,
      );
    }
    if (command === "compact") {
      const result = compact({ path });
      return success(
        result,
        json,
        `${result.events} event(s) from ${result.days} day(s) folded into daily summaries`,
      );
    }
    const limit = filter.limit ?? DEFAULT_LIMIT;
    const { events, more } = queryEventPage(
      {
        ...filter,
        limit,
        ...(allWorkspaces
          ? {}
          : { workspace: resolveCheckout(context.cwd).workspace }),
      },
      { path },
    );
    if (!more) return success(events, json, formatTable(events));
    // A page after a cursor keeps its first events; a tail keeps its newest.
    const paged = filter.afterId !== undefined;
    const shown = `${limit} matching event${limit === 1 ? "" : "s"}`;
    const note = paged
      ? `forge:audit: showing the first ${shown} after id ${filter.afterId}; more follow — continue with --after-id ${events[events.length - 1]?.id}`
      : `forge:audit: showing the newest ${shown}; older ones were left out — raise --limit or narrow the filters`;
    return { ...success(events, json, formatTable(events)), stderr: note };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

if (import.meta.main) {
  const outcome = runAudit(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
  });
  console.log(outcome.stdout);
  if (outcome.stderr !== undefined) console.error(outcome.stderr);
  process.exit(outcome.code);
}
