import type { OwnedConversationAddress } from "../../types/conversation";
import type { ProjectShiftIntent } from "../../types/project-shifts";
import { openOwnedConversationTurn } from "../conversations/owned-turn";
import {
  PrivateCaptureError,
  type PrivateExecInput,
} from "../executors/private-capture";
import { codexOwnedMetadataSchema } from "../sessions/codex-owned-metadata";
import { ownedSessionMetadataSchema } from "../sessions/protocol";
import { createSessionRegistry } from "../sessions/registry";
import {
  prepareShiftTurnSnapshot,
  shiftAttemptHash,
  shiftAttemptOrigin,
  shiftAttemptRequestId,
} from "./attempt-identity";

/** Opens one fresh private attempt. A known reservation is recovery evidence, never dispatch authority. */
export async function openShiftAttempt(options: {
  home: string;
  intent: ProjectShiftIntent;
  input: PrivateExecInput;
  attempt: number;
  signal: AbortSignal;
  prepare(input: PrivateExecInput): Promise<{ version: string }>;
  validate(input: PrivateExecInput): Promise<void>;
}) {
  const intent = structuredClone(options.intent),
    input = structuredClone(options.input),
    attempt = options.attempt;
  const active = () => {
    if (options.signal.aborted) throw new PrivateCaptureError();
  };
  try {
    active();
    const origin = shiftAttemptOrigin(intent, input, attempt),
      requestId = shiftAttemptRequestId(intent, input, attempt);
    const index = createSessionRegistry(options.home);
    if (
      index.listAll(intent.projectId).some((row) => row.requestId === requestId)
    )
      throw new PrivateCaptureError();
    if (input.provider !== "claude" && input.provider !== "codex")
      throw new PrivateCaptureError();
    const prepared = await options.prepare(structuredClone(input));
    active();
    const requestHash = shiftAttemptHash(
      intent,
      input,
      attempt,
      prepared.version,
    );
    const metadata = {
      mode: "task",
      provider: input.provider,
      workspace: input.workspace,
      repository: input.workspace,
      worktree: input.cwd,
      beadId: input.beadId,
      smith: input.smith.name,
      requestedModel: input.smith.model,
      requestedEffort: input.smith.effort,
      origin,
    };
    let created = false;
    const admit = async () => {
      active();
      await options.validate(structuredClone(input));
      active();
      created = true;
    };
    const record =
      input.provider === "codex"
        ? await createSessionRegistry(options.home, "codex").reserve(
            intent.projectId,
            requestId,
            requestHash,
            async () => {
              await admit();
              return codexOwnedMetadataSchema.parse(metadata);
            },
          )
        : await index.reserve(
            intent.projectId,
            requestId,
            requestHash,
            async () => {
              await admit();
              return ownedSessionMetadataSchema.parse(metadata);
            },
          );
    // A concurrent creator or an aborted writer may have left only metadata.
    // Neither case is permission to create or repeat its private provider turn.
    active();
    if (!created) throw new PrivateCaptureError();
    const address: OwnedConversationAddress = {
      kind: "session",
      projectId: intent.projectId,
      sessionId: record.id,
    };
    const snapshot = prepareShiftTurnSnapshot(
      intent,
      input,
      attempt,
      prepared.version,
      record.id,
    );
    const owner = await openOwnedConversationTurn({
      home: options.home,
      address,
      signal: options.signal,
      input: {
        requestId,
        expectedRevision: 0,
        text: input.stdin,
        about: [
          { kind: "bead", id: snapshot.beadId },
          { kind: "run", id: snapshot.runId },
        ],
        shift: snapshot,
      },
    });
    return { record, address, snapshot, owner };
  } catch {
    throw new PrivateCaptureError();
  }
}
