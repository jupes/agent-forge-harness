/**
 * The shift rows of the operator API: `GET /shifts`,
 * `POST /shifts/:id/stop` and `POST /shifts/:id/recover`
 * (`03-target-architecture.md` §6).
 *
 * Each is a way in to the function the matching `forge:shift` command calls:
 * the list reads the shift records in the hearth's home (`shift-store.ts`), a
 * stop writes the request a running shift looks for on its next tick (the
 * shift itself stops its runs, gives their beads back to `queued` and records
 * `shift.stopped`; this row does none of that), and a recover gives back what
 * a shift whose process ended still holds (`shift-recover.ts`). Starting a
 * shift from here (`POST /shifts`) is not mounted.
 */

import type { LedgerEventInput } from "../../../types/hearth";
import type { AppendResult } from "../../ledger/append";
import {
  type RecoverFailure,
  recoverShift,
  unfinishedMessage,
} from "../../scheduler/shift-recover";
import {
  isShiftId,
  listShiftRecords,
  readShiftRecord,
  requestStop,
} from "../../scheduler/shift-store";
import type { ActionRoute, ApiRoute, ReadRoute, RouteRequest } from "../api";
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
}

/** Why a recovery was refused, as a status; never 403 (a 403 means refused before anything was done). */
const RECOVER_STATUS: Record<RecoverFailure, number> = {
  invalid: 400,
  "not-found": 404,
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

export function shiftRoutes(deps: ShiftRouteDeps): ApiRoute[] {
  const list: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    path: "/shifts",
    validate: noParameters,
    read: () => ({
      status: 200,
      data: listShiftRecords(deps.shiftsDir).filter(
        (record) => record.workspace === deps.workspace,
      ),
    }),
  };

  const stop: ActionRoute<string> = {
    kind: "action",
    method: "POST",
    path: "/shifts/:id/stop",
    action: "shift.stop",
    validate: namedShift,
    subject: (id) => ({ target: id }),
    effect: (id) => {
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

  return [list, stop, recover];
}
