/**
 * The shift rows of the operator API: `GET /shifts` and
 * `POST /shifts/:id/stop` (`03-target-architecture.md` §6).
 *
 * Both are ways in to `scripts/scheduler/shift-store.ts`, the same functions
 * `forge:shift list` and `forge:shift stop` call: the list reads the shift
 * records in the hearth's home, and a stop writes the request a running shift
 * looks for on its next tick. The shift itself stops its runs, gives their
 * beads back to `queued` and records `shift.stopped`; this row does none of
 * that. Starting a shift from here (`POST /shifts`) is not mounted.
 */

import {
  isShiftId,
  listShiftRecords,
  readShiftRecord,
  requestStop,
} from "../../scheduler/shift-store";
import type { ActionRoute, ApiRoute, ReadRoute } from "../api";
import { bodyFields, fail, noParameters } from "./operator-reads";

export interface ShiftRouteDeps {
  /** The workspace this hearth serves: only its shifts are listed or stopped. */
  workspace: string;
  /** `<home>/shifts`, where shifts given this hearth's home keep their records. */
  shiftsDir: string;
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
    validate: (request) => {
      const given = bodyFields(request, []);
      if (!given.ok) return given;
      const id = request.params["id"];
      return isShiftId(id)
        ? { ok: true, value: id }
        : fail("id: expected a shift id (shift-YYYYMMDD-HHMMSS-xxxx)");
    },
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

  return [list, stop];
}
