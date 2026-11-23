/**
 * audit-core.ts — importable audit implementation; importing never dispatches.
 *
 * CLI:
 *   bun run forge:audit --bead <id> [--bead-exact]   # a bead, plus the other events of sessions that touched it
 *   bun run forge:audit --run <slug>                 # one Forge run
 *   bun run forge:audit --shift <id>                 # one shift: its start and stop, and the events of every bead run it made
 *   bun run forge:audit --session <id>               # one session
 *   bun run forge:audit --since <iso> --kind <k>[,<k>]
 *   bun run forge:audit --limit <n> [--after-id <n>] # newest n, or the n after a cursor (default limit 500)
 *   bun run forge:audit --all-workspaces             # default scope is the checkout of the current directory
 *   bun run forge:audit --json                       # { ok, data, error } instead of a table
 *   bun run forge:audit --backup                     # snapshot to backups/, prune snapshots past 14 days
 *   bun run forge:audit --compact                    # fold events past 90 days into daily counts
 *   bun run forge:audit --scoreboard [--since <iso>] # per executor: sessions, gates, verdicts, reviews, council, usage (scoreboard.ts)
 *
 * `--shift` takes the id `forge:shift` printed (`shift-YYYYMMDD-HHMMSS-xxxx`)
 * and refuses anything else. It finds the shift's runs from the ledger alone, by
 * the run ids the shift gave its beads (`shiftClause` in `query.ts`), so it
 * answers when the shift's record file is gone; an id no event carries answers
 * an empty list, as an unknown `--run` does.
 *
 * Filters combine (AND). `--scoreboard` takes only `--since`,
 * `--all-workspaces` and `--json`; its scope is the query's. Exit code 0 when
 * ok; on any error the envelope is printed (with or without --json) and the
 * exit code is 2.
 *
 * When more events match than the limit, the result is cut and one line on
 * stderr says so, with and without --json. So does one more line when the
 * scope is a value the ledger refuses to store (a checkout path, bead, run or
 * session the secret scanner flags): an empty answer there does not mean that
 * nothing happened. The notes are not fields of the envelope: `data` stays the
 * array of events its readers parse, and stdout stays the envelope alone.
 */

import {
  LEDGER_EVENT_KINDS,
  type LedgerEvent,
  type LedgerEventKind,
  type OperatorEnvelope,
} from "../../types/hearth";
import { isShiftId } from "../scheduler/shift-store";
import { refusedJoinValue } from "./append";
import { backupLedger, compact } from "./backup";
import { ledgerPath } from "./paths";
import { type EventFilter, queryEventPage } from "./query";
import { formatScoreboard, readScoreboard } from "./scoreboard";
import { resolveCheckout } from "./workspace";

export const DEFAULT_LIMIT = 500;

export interface AuditArgs {
  command: "query" | "backup" | "compact" | "scoreboard";
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
  "--shift",
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
  "--scoreboard",
] as const;

/** What `--scoreboard` may be given besides itself. */
const SCOREBOARD_FLAGS: readonly string[] = [
  "--scoreboard",
  "--since",
  "--all-workspaces",
  "--json",
];

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

/** The `--since` value when it is an ISO 8601 instant, or why not. */
function sinceOf(
  since: string,
): { ok: true; value: string } | { ok: false; error: string } {
  return ISO_8601.test(since) && !Number.isNaN(Date.parse(since))
    ? { ok: true, value: since }
    : {
        ok: false,
        error: `--since: expected an ISO 8601 timestamp such as 2026-10-07T00:00:00Z, got "${since}"`,
      };
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
  if (switches.has("--scoreboard")) {
    const other = [...values.keys(), ...switches].find(
      (flag) => !SCOREBOARD_FLAGS.includes(flag),
    );
    if (other !== undefined)
      return fail(
        `--scoreboard takes no other flag than --since, --all-workspaces and --json (got ${other})`,
      );
    const given = values.get("--since");
    const since = given === undefined ? null : sinceOf(given);
    if (since !== null && !since.ok) return since;
    return {
      ok: true,
      value: {
        command: "scoreboard",
        json,
        allWorkspaces: switches.has("--all-workspaces"),
        filter: since === null ? {} : { since: since.value },
      },
    };
  }
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
  const shift = values.get("--shift");
  if (shift !== undefined) {
    if (!isShiftId(shift))
      return fail(
        `--shift: expected a shift id of the form shift-YYYYMMDD-HHMMSS-xxxx (as forge:shift prints it), got "${shift}"`,
      );
    filter.shiftId = shift;
  }
  const session = values.get("--session");
  if (session !== undefined) filter.sessionId = session;

  const given = values.get("--since");
  if (given !== undefined) {
    const since = sinceOf(given);
    if (!since.ok) return since;
    filter.since = since.value;
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

/**
 * The `action` an event's payload names: what a review round decided
 * (`review.recorded`), the write a `bead.transitioned` records, or what an
 * `operator.action` did. A dash for an event without one.
 */
function actionOf(event: LedgerEvent): string {
  const action = "action" in event.payload ? event.payload.action : undefined;
  return typeof action === "string" ? action : "-";
}

const COLUMNS: ReadonlyArray<[string, (event: LedgerEvent) => string]> = [
  ["id", (event) => String(event.id)],
  ["ts", (event) => event.ts],
  ["kind", (event) => event.kind],
  ["action", actionOf],
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

/**
 * A note for a query scoped to a value the ledger refuses (`refusedJoinValue`):
 * the checkout it runs from, or the bead, run or session it names. Nothing
 * that carries such a value is stored, so an empty answer would otherwise
 * read as "nothing happened". Null when the scope holds no such value.
 */
function refusedScopeNote(filter: EventFilter): string | null {
  const scope: ReadonlyArray<[string, Parameters<typeof refusedJoinValue>[0]]> =
    [
      [
        "the checkout of the current directory",
        { workspace: filter.workspace },
      ],
      ["the --bead value", { beadId: filter.beadId }],
      ["the --run value", { runId: filter.runId }],
      ["the --session value", { sessionId: filter.sessionId }],
    ];
  for (const [subject, values] of scope) {
    const refused = refusedJoinValue(values);
    if (refused !== null)
      return `forge:audit: ${subject} looks like a secret to the ledger's scanner (${refused.kind}); the ledger refuses every event that carries such a value, so what happened under it is not recorded (scripts/ledger/AGENTS.md)`;
  }
  return null;
}

export interface AuditOutcome {
  code: 0 | 2;
  stdout: string;
  /**
   * Notes for the reader that are not part of the answer: the result was cut
   * at the limit, or its scope is a value the ledger refuses to store.
   */
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
    if (command === "scoreboard") {
      const workspace = allWorkspaces
        ? undefined
        : resolveCheckout(context.cwd).workspace;
      const board = readScoreboard(
        {
          ...(workspace !== undefined ? { workspace } : {}),
          ...(filter.since !== undefined ? { since: filter.since } : {}),
        },
        { path },
      );
      const outcome = success(board, json, formatScoreboard(board));
      const refused = refusedScopeNote(
        workspace !== undefined ? { workspace } : {},
      );
      return refused === null ? outcome : { ...outcome, stderr: refused };
    }
    const limit = filter.limit ?? DEFAULT_LIMIT;
    const scope: EventFilter & { limit: number } = {
      ...filter,
      limit,
      ...(allWorkspaces
        ? {}
        : { workspace: resolveCheckout(context.cwd).workspace }),
    };
    const { events, more } = queryEventPage(scope, { path });
    const notes: string[] = [];
    if (more) {
      // A page after a cursor keeps its first events; a tail keeps its newest.
      const paged = filter.afterId !== undefined;
      const shown = `${limit} matching event${limit === 1 ? "" : "s"}`;
      notes.push(
        paged
          ? `forge:audit: showing the first ${shown} after id ${filter.afterId}; more follow — continue with --after-id ${events[events.length - 1]?.id}`
          : `forge:audit: showing the newest ${shown}; older ones were left out — raise --limit or narrow the filters`,
      );
    }
    const refused = refusedScopeNote(scope);
    if (refused !== null) notes.push(refused);
    const outcome = success(events, json, formatTable(events));
    return notes.length === 0
      ? outcome
      : { ...outcome, stderr: notes.join("\n") };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}
