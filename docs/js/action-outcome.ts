/**
 * What one operator action's answer means, when the page cannot always tell.
 *
 * The same rules as the tracker writes (`islands/bead-writes.ts`) and the
 * Workbench moves (`workbench-model.ts`), for the actions that have no model
 * of their own: starting or cancelling a council run, and recording a
 * checkpoint review.
 *
 * - `done`: the control plane answered `ok: true`.
 * - `refused`: nothing was changed. The control plane refused in its own
 *   words, or no operator token could be had (`NotSent`), so no request left
 *   the page or only one a 403 turned away.
 * - `unknown`: the request may have been acted on. It was sent and then
 *   failed (no answer within the deadline, the connection dropped), or it was
 *   answered with a 504, or with something that is not the control plane's
 *   envelope. The page must not offer the same action again as if nothing
 *   happened: a second council start is a second paid run, a second review a
 *   second comment. It says how to check, and holds the action until it has
 *   read the state again or the operator says they have checked.
 */

import { NotSent } from "./operator";

export type ActionOutcome =
  | { state: "done"; data: unknown }
  | { state: "refused"; message: string }
  | { state: "unknown"; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A failure's own words, as one sentence. */
function sentence(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim();
  return text.endsWith(".") ? text : `${text}.`;
}

/**
 * Send one action and say what its answer means. `check` is the sentence an
 * outcome nobody can vouch for ends with: what may have happened and how to
 * see for oneself. Never rejects.
 */
export async function actionOutcome(
  send: () => Promise<Response>,
  check: string,
): Promise<ActionOutcome> {
  let response: Response;
  try {
    response = await send();
  } catch (error) {
    if (error instanceof NotSent)
      return {
        state: "refused",
        message: `Not sent: the page could not get an operator token from the control plane (${error.message}). Nothing was changed.`,
      };
    return {
      state: "unknown",
      message: `The request did not complete: ${sentence(error)} ${check}`,
    };
  }
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  const error =
    isRecord(parsed) && typeof parsed["error"] === "string"
      ? parsed["error"]
      : null;
  if (!isRecord(parsed) || typeof parsed["ok"] !== "boolean")
    return {
      state: "unknown",
      message: `The answer (HTTP ${response.status}) did not come from the control plane. ${check}`,
    };
  // 504 is the one status the control plane uses for "outcome not known".
  if (response.status === 504)
    return {
      state: "unknown",
      message: `${sentence(error ?? "The control plane could not tell whether it was done")} ${check}`,
    };
  if (response.ok && parsed["ok"] === true)
    return { state: "done", data: parsed["data"] };
  if (response.ok)
    return {
      state: "unknown",
      message: `The control plane answered without saying it was done. ${check}`,
    };
  return { state: "refused", message: error ?? `HTTP ${response.status}` };
}
