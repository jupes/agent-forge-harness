import { createHash } from "node:crypto";
import type { ProjectShiftIntent } from "../../types/project-shifts";
import type {
  ProjectShiftAttemptOrigin,
  ShiftTurnSnapshot,
} from "../../types/shift-turn";
import {
  PrivateCaptureError,
  type PrivateExecInput,
} from "../executors/private-capture";
import { workspaceKey } from "../projects/scope";
import { projectShiftRequestHash } from "./registry";
import { shiftTurnSnapshotSchema } from "./turn-protocol";

/** RFC4122 DNS namespace; name grammar and field order below are immutable version1 bytes. */
const UUID_NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");
export const SHIFT_ATTEMPT_NAMESPACE = "agent-forge:project-shift-attempt:v1";

export function shiftAttemptOrigin(
  intent: ProjectShiftIntent,
  input: PrivateExecInput,
  attempt: number,
): ProjectShiftAttemptOrigin {
  if (
    intent.requestHash !==
      projectShiftRequestHash(
        intent.projectId,
        intent.workspace,
        intent.request,
      ) ||
    workspaceKey(input.workspace) !== workspaceKey(intent.workspace) ||
    input.runId === null ||
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    attempt > intent.request.options.repairs + 1
  )
    throw new PrivateCaptureError();
  return {
    kind: "shift",
    projectId: intent.projectId,
    originalRequestId: intent.request.requestId,
    shiftId: intent.shiftId,
    runId: input.runId,
    beadId: input.beadId,
    attempt,
  };
}

/** Stable identity excludes mutable prepared input; changed input must conflict under the same UUID. */
export function shiftAttemptRequestId(
  intent: ProjectShiftIntent,
  input: PrivateExecInput,
  attempt: number,
): string {
  const origin = shiftAttemptOrigin(intent, input, attempt);
  const name = JSON.stringify({
    namespace: SHIFT_ATTEMPT_NAMESPACE,
    workspace: workspaceKey(intent.workspace),
    ...origin,
  });
  const bytes = createHash("sha1")
    .update(UUID_NAMESPACE)
    .update(name)
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function prepareShiftTurnSnapshot(
  intent: ProjectShiftIntent,
  input: PrivateExecInput,
  attempt: number,
  cliVersion: string,
  conversationId: string,
): ShiftTurnSnapshot {
  const origin = shiftAttemptOrigin(intent, input, attempt);
  const { kind: _kind, ...source } = origin;
  if (input.provider !== input.smith.provider) throw new PrivateCaptureError();
  const parsed = shiftTurnSnapshotSchema.safeParse({
    ...source,
    version: 1,
    conversationId,
    turnId: shiftAttemptRequestId(intent, input, attempt),
    provider: input.provider,
    cliVersion,
    workspace: input.workspace,
    cwd: input.cwd,
    smith: input.smith.name,
    requestedModel: input.smith.model,
    requestedEffort: input.smith.effort,
    command: input.command,
    stdin: input.stdin,
    timeoutMs: input.timeoutMs,
  });
  if (!parsed.success) throw new PrivateCaptureError();
  return parsed.data;
}

/** Hash full original scope/body and actual input; no environment values exist in PrivateExecInput. */
export function shiftAttemptHash(
  intent: ProjectShiftIntent,
  input: PrivateExecInput,
  attempt: number,
  cliVersion: string,
): string {
  const turnId = shiftAttemptRequestId(intent, input, attempt);
  const snapshot = prepareShiftTurnSnapshot(
    intent,
    input,
    attempt,
    cliVersion,
    `session-${turnId}`,
  );
  const { conversationId: _address, ...prepared } = snapshot;
  return createHash("sha256")
    .update(
      JSON.stringify({
        namespace: SHIFT_ATTEMPT_NAMESPACE,
        original: {
          projectId: intent.projectId,
          workspace: workspaceKey(intent.workspace),
          shiftId: intent.shiftId,
          request: intent.request,
          requestHash: intent.requestHash,
        },
        prepared,
      }),
    )
    .digest("hex");
}
