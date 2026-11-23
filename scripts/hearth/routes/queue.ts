/**
 * The queue rows of the operator API: propose, approve, queue, pause, resume
 * and reassign (`03-target-architecture.md` §6). `propose` (`x1gs.5.10`) puts
 * a bead outside the queue, or one carrying a queue label the queue did not
 * write (inherited from a parent, or added by hand), in the queue as
 * `proposed`; `resume` of a bead paused while running puts it in `queued`
 * (`x1gs.5.4.4`).
 *
 * Each is a way in to `scripts/scheduler/queue.ts`, as the operator: the
 * table of legal moves, the lock, the `bd` calls and the `bead.transitioned`
 * event are all there, and nothing of them is repeated here. What a row must
 * not decide for itself (origin, token, body, the audit row, the envelope) is
 * in `../api.ts`.
 */

import type { LedgerEventInput, QueueAction } from "../../../types/hearth";
import { type ForgeConfig, loadConfig } from "../../config/load";
import type { AppendResult } from "../../ledger/append";
import {
  checkSmith,
  createQueue,
  type QueueFailure,
  type QueueOutcome,
} from "../../scheduler/queue";
import type { ActionRoute, ApiRoute, RouteReply, RouteRequest } from "../api";
import { isBeadId } from "../tracker-write";
import type { ValidationResult } from "../validate";
import type { BdRunner } from "./dev-api";
import { bodyFields, fail, looksLikeSecret } from "./operator-reads";

export interface QueueRouteDeps {
  /** The checkout this hearth serves: the smiths are read from its config. */
  root: string;
  /** The workspace the transition events are recorded under. */
  workspace: string;
  /** Runs `bd` in the checkout that holds the tracker. */
  runBd: BdRunner;
  /** The ledger's `appendEvent`, bound to this hearth's ledger. */
  appendEvent(event: LedgerEventInput): AppendResult;
  /** The queue lock's file, under the hearth's home. */
  lockFile: string;
  /** The OS home the machine config file is read from; defaults to the real one. */
  configHome?: string | undefined;
}

/** The queue lock's file name, in the harness home (`AGENT_FORGE_HOME`). */
export const QUEUE_LOCK_FILE = "queue-lock.db";

/** The moves an operator makes through the API. The others are the scheduler's, or made by hand. */
export const OPERATOR_QUEUE_ACTIONS = [
  "propose",
  "approve",
  "queue",
  "pause",
  "resume",
] as const satisfies readonly QueueAction[];

/**
 * What each way of not making a move answers. Never 403: the page posts an
 * action again after a 403, which is safe only while a 403 always means
 * "refused before anything was done". 504 is the one status that means the
 * outcome is not known.
 */
const STATUS: Record<QueueFailure, number> = {
  invalid: 400,
  "not-found": 404,
  refused: 409,
  busy: 409,
  // This conflict is discovered only after a successful tracker update.
  conflict: 504,
  failed: 502,
  unknown: 504,
};

function reply<T>(outcome: QueueOutcome<T>): RouteReply {
  return outcome.ok
    ? { status: 200, data: outcome.value }
    : { status: STATUS[outcome.kind], error: outcome.error };
}

/** The bead the path names, when the body holds nothing but `allowed`. */
function namedBead(
  request: RouteRequest,
  allowed: readonly string[],
): ValidationResult<{ id: string; body: Record<string, unknown> }> {
  const given = bodyFields(request, allowed);
  if (!given.ok) return given;
  const id = request.params["id"];
  return isBeadId(id)
    ? { ok: true, value: { id, body: given.value } }
    : fail("id: expected a Beads issue id");
}

interface Reassign {
  id: string;
  smith: string;
  /** The config the smith was checked against. */
  config: ForgeConfig;
}

export function queueRoutes(deps: QueueRouteDeps): ApiRoute[] {
  const queue = createQueue({
    workspace: deps.workspace,
    runBd: deps.runBd,
    appendEvent: deps.appendEvent,
    lockFile: deps.lockFile,
  });

  const move = (action: (typeof OPERATOR_QUEUE_ACTIONS)[number]) => {
    const row: ActionRoute<string> = {
      kind: "action",
      method: "POST",
      path: `/queue/:id/${action}`,
      action: `queue.${action}`,
      validate: (request) => {
        const named = namedBead(request, []);
        return named.ok ? { ok: true, value: named.value.id } : named;
      },
      subject: (id) => ({ target: id, beadId: id }),
      effect: async (id) => reply(await queue.move(id, action, "operator")),
    };
    return row;
  };

  /**
   * The smith is checked against the configured smiths here, before the audit
   * row: it is what that row names. The config is the one `GET /smiths`
   * reads; one that cannot be read throws, which the runner answers as 500
   * with nothing recorded and nothing done.
   */
  function reassignInput(request: RouteRequest): ValidationResult<Reassign> {
    const named = namedBead(request, ["smith"]);
    if (!named.ok) return named;
    const smith = named.value.body["smith"];
    if (typeof smith !== "string" || looksLikeSecret(smith))
      return fail("smith: expected the name of a configured smith");
    const { config } = loadConfig({
      harnessRoot: deps.root,
      env: {},
      ...(deps.configHome !== undefined ? { home: deps.configHome } : {}),
    });
    const checked = checkSmith(config, smith);
    return checked.ok
      ? {
          ok: true,
          value: { id: named.value.id, smith: checked.smith, config },
        }
      : fail(checked.error);
  }

  const reassign: ActionRoute<Reassign> = {
    kind: "action",
    method: "POST",
    path: "/queue/:id/reassign",
    action: "queue.reassign",
    validate: reassignInput,
    // The bead is the subject; the smith is what the action names.
    subject: (input) => ({ target: input.smith, beadId: input.id }),
    effect: async (input) =>
      reply(await queue.reassign(input.id, input.smith, input.config)),
  };

  return [...OPERATOR_QUEUE_ACTIONS.map(move), reassign];
}
