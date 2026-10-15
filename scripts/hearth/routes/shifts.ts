/**
 * The shift rows of the operator API: `GET /shifts`, `POST /shifts`,
 * `POST /shifts/:id/stop` and `POST /shifts/:id/recover`
 * (`03-target-architecture.md` §6).
 *
 * Each is a way in to what the matching `forge:shift` command does: the list
 * reads the shift records in the hearth's home (`shift-store.ts`), a start
 * runs `forge:shift run` as a child the hearth supervises (`../shift-launcher.ts`),
 * a stop writes the request a running shift looks for on its next tick (the
 * shift itself stops its runs, gives their beads back to `queued` and records
 * `shift.stopped`; this row does none of that), and a recover gives back what
 * a shift whose process ended still holds (`shift-recover.ts`).
 */

import type { LedgerEventInput } from "../../../types/hearth";
import type { AppendResult } from "../../ledger/append";
import { shiftOptions } from "../../scheduler/shift";
import { runOptions } from "../../scheduler/shift-cli";
import {
  type RecoverFailure,
  recoverShift,
  unfinishedMessage,
} from "../../scheduler/shift-recover";
import {
  isShiftId,
  type ListedShift,
  listShiftRecords,
  readShiftRecord,
  requestStop,
} from "../../scheduler/shift-store";
import type {
  ActionRoute,
  ApiRoute,
  ReadRoute,
  RouteReply,
  RouteRequest,
} from "../api";
import type { ShiftLaunchEntry, ShiftStarts } from "../shift-launcher";
import type { ValidationResult } from "../validate";
import type { BdRunner } from "./dev-api";
import { bodyFields, fail, noParameters } from "./operator-reads";

export interface ShiftRouteDeps {
  /** The workspace this hearth serves: only its shifts are listed, stopped or recovered. */
  workspace: string;
  /** `<home>/shifts`, where shifts given this hearth's home keep their records. */
  shiftsDir: string;
  /** Runs `bd` in the checkout that holds the tracker. */
  runBd: BdRunner;
  ledgerPath: string;
  /** The ledger's `appendEvent`, bound to this hearth's ledger. */
  appendEvent(event: LedgerEventInput): AppendResult;
  /** The queue lock's file, under the hearth's home: the one shifts take. */
  lockFile: string;
  /** The main checkout: a shift's worktrees are `<main>/trees/<shift-id>-<n>`. */
  mainCheckout: string;
  /** The shifts this hearth starts, and what it knows of them before their records exist. */
  starts: ShiftStarts;
}

/** What `GET /shifts` lists: a shift's record, or a start of this hearth that has none yet. */
export type ShiftListEntry = ListedShift | ShiftLaunchEntry;

/**
 * The fields a start takes, each with the `forge:shift run` flag it becomes.
 * Named as the CLI names them, flat: `epic` is the filter (§6 wrote it
 * `filter`), as the council's body is flat.
 */
export const START_FIELDS = {
  for: "--for",
  concurrency: "--concurrency",
  maxBeads: "--max-beads",
  maxUsd: "--max-usd",
  repairs: "--repairs",
  epic: "--epic",
  smith: "--smith",
  runTimeout: "--run-timeout",
  base: "--base",
} as const;

type StartField = keyof typeof START_FIELDS;

const NUMBER_FIELDS: ReadonlySet<StartField> = new Set([
  "concurrency",
  "maxBeads",
  "maxUsd",
  "repairs",
]);
const DURATION_FIELDS: ReadonlySet<StartField> = new Set(["for", "runTimeout"]);

/** The CLI's and the shift's names for a field, as the body names it. */
const BODY_NAMES: ReadonlyArray<readonly [string, string]> = [
  ...Object.entries(START_FIELDS).map(
    ([field, flag]) => [flag, field] as const,
  ),
  ["forMs", "for (in milliseconds)"],
  ["runTimeoutMs", "runTimeout (in milliseconds)"],
];

/** A refusal of the CLI's or the shift's own, with the field named as the body names it. */
function inBodyNames(error: string): string {
  for (const [name, field] of BODY_NAMES)
    if (error.startsWith(`${name}:`) || error.startsWith(`${name} `))
      return `${field}${error.slice(name.length)}`;
  return error;
}

/** A start: the id minted for it, the flags it passes on, and the fields it was given. */
export interface ShiftStart {
  shiftId: string;
  flags: string[];
  requested: Record<string, unknown>;
}

/** Why a recovery was refused, as a status; never 403 (a 403 means refused before anything was done). */
const RECOVER_STATUS: Record<RecoverFailure, number> = {
  invalid: 400,
  "not-found": 404,
  unreadable: 409,
  stopped: 409,
  alive: 409,
  busy: 409,
  failed: 502,
};

/** The shift the path names, with an empty body. */
function namedShift(request: RouteRequest): ValidationResult<string> {
  const given = bodyFields(request, []);
  if (!given.ok) return given;
  const id = request.params["id"];
  return isShiftId(id)
    ? { ok: true, value: id }
    : fail("id: expected a shift id (shift-YYYYMMDD-HHMMSS-xxxx)");
}

/**
 * The body as `forge:shift run` flags, checked as the child will check them:
 * by the CLI's own parser and then `shiftOptions`, on exactly those flags,
 * with no rule of this row's own beyond the JSON type of each field. Only the
 * fields the body gave become flags, so the CLI applies its own defaults to
 * the rest. The shift id is minted last, once the body is good, so that the
 * audit row names the shift it starts.
 */
function startInput(
  starts: ShiftStarts,
): (request: RouteRequest) => ValidationResult<ShiftStart> {
  return (request) => {
    const given = bodyFields(request, Object.keys(START_FIELDS));
    if (!given.ok) return given;
    const flags: string[] = [];
    for (const [field, flag] of Object.entries(START_FIELDS) as Array<
      [StartField, string]
    >) {
      const value = given.value[field];
      if (value === undefined) continue;
      if (NUMBER_FIELDS.has(field)) {
        if (typeof value !== "number" || !Number.isFinite(value))
          return fail(`${field}: expected a number`);
      } else if (typeof value !== "string")
        return fail(
          DURATION_FIELDS.has(field)
            ? `${field}: expected a duration such as 90s, 30m or 2h`
            : `${field}: expected a string`,
        );
      flags.push(flag, String(value));
    }
    const parsed = runOptions(flags);
    if (!parsed.ok) return fail(inBodyNames(parsed.error));
    const checked = shiftOptions(parsed.value);
    if (!checked.ok) return fail(inBodyNames(checked.error));
    return {
      ok: true,
      value: { shiftId: starts.mint(), flags, requested: given.value },
    };
  };
}

export function shiftRoutes(deps: ShiftRouteDeps): ApiRoute[] {
  /** A start of this hearth whose record does not exist yet has nothing to stop or give back. */
  const stillStarting = (id: string): RouteReply | null =>
    deps.starts.isStarting(id)
      ? {
          status: 409,
          error: `${id} is still starting: it has no record yet. Ask again once GET /shifts lists it as running.`,
        }
      : null;

  const list: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    path: "/shifts",
    validate: noParameters,
    read: () => {
      const listed: ShiftListEntry[] = [
        ...listShiftRecords(deps.shiftsDir).filter(
          (record) => record.workspace === deps.workspace,
        ),
        ...deps.starts.unrecorded(),
      ];
      return {
        status: 200,
        data: listed.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
      };
    },
  };

  const start: ActionRoute<ShiftStart> = {
    kind: "action",
    method: "POST",
    path: "/shifts",
    action: "shift.start",
    validate: startInput(deps.starts),
    subject: (input) => ({ target: input.shiftId }),
    effect: (input) => {
      // One start at a time: a second while the first has no record would be
      // a double submit, or the same fetch failing twice.
      const busy = deps.starts.starting();
      if (busy !== null)
        return {
          status: 409,
          error: `${busy} is still starting (it has no record yet), and a shift starts one at a time: ask again once GET /shifts lists it as running or failed. Nothing was started.`,
        };
      const started = deps.starts.start(
        input.shiftId,
        input.flags,
        input.requested,
      );
      if (!started.ok)
        return {
          status: started.kind === "closing" ? 503 : 502,
          error: started.error,
        };
      return {
        status: 202,
        data: {
          ...started.value,
          stop: `/shifts/${input.shiftId}/stop`,
          recover: `/shifts/${input.shiftId}/recover`,
        },
      };
    },
  };

  const stop: ActionRoute<string> = {
    kind: "action",
    method: "POST",
    path: "/shifts/:id/stop",
    action: "shift.stop",
    validate: namedShift,
    subject: (id) => ({ target: id }),
    effect: (id) => {
      const starting = stillStarting(id);
      if (starting !== null) return starting;
      // Another workspace's shift is not this hearth's to stop.
      const record = readShiftRecord(deps.shiftsDir, id);
      if (record === null || record.workspace !== deps.workspace)
        return {
          status: 404,
          error: `No shift of this workspace has the id ${id}.`,
        };
      const asked = requestStop(deps.shiftsDir, id);
      if (asked.ok) return { status: 200, data: asked.value };
      return {
        status:
          asked.kind === "stopped" ? 409 : asked.kind === "invalid" ? 400 : 404,
        error: asked.error,
      };
    },
  };

  // A shift of another workspace is not found by `recoverShift` itself.
  const recover: ActionRoute<string> = {
    kind: "action",
    method: "POST",
    path: "/shifts/:id/recover",
    action: "shift.recover",
    validate: namedShift,
    subject: (id) => ({ target: id }),
    effect: async (id) => {
      const starting = stillStarting(id);
      if (starting !== null) return starting;
      const recovered = await recoverShift(id, {
        workspace: deps.workspace,
        runBd: deps.runBd,
        ledgerPath: deps.ledgerPath,
        appendEvent: deps.appendEvent,
        lockFile: deps.lockFile,
        shiftsDir: deps.shiftsDir,
        mainCheckout: deps.mainCheckout,
      });
      if (!recovered.ok)
        return {
          status: RECOVER_STATUS[recovered.kind],
          error: recovered.error,
        };
      return recovered.value.complete
        ? { status: 200, data: recovered.value }
        : { status: 502, error: unfinishedMessage(recovered.value) };
    },
  };

  return [list, start, stop, recover];
}
