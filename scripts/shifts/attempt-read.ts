import { lstatSync } from "node:fs";
import type { OwnedCodingSessionRecord } from "../../types/codex-owned-task";
import type { ConversationState } from "../../types/conversation";
import type { ProjectShiftIntent } from "../../types/project-shifts";
import type { ProjectShiftAttemptsPage } from "../../types/shift-attempts";
import { ConversationError } from "../conversations/error";
import {
  type ConversationPageQuery,
  conversationPage,
  validateConversationPageQuery,
} from "../conversations/page";
import { conversationLeaseFile } from "../conversations/paths";
import { createConversationStore } from "../conversations/store";
import type { PrivateExecInput } from "../executors/private-capture";
import { readHomeFile } from "../hearth/home-guard";
import { workspaceKey } from "../projects/scope";
import { withQueueLock } from "../scheduler/queue-lock";
import { sessionRequestIdSchema } from "../sessions/identity-protocol";
import { canonicalSessionInput } from "../sessions/preparation";
import { createSessionRegistry } from "../sessions/registry";
import {
  prepareShiftTurnSnapshot,
  shiftAttemptHash,
  shiftAttemptOrigin,
  shiftAttemptRequestId,
} from "./attempt-identity";
import {
  projectShiftAttemptsPageSchema,
  SHIFT_ATTEMPT_METADATA_REASON,
} from "./attempt-read-protocol";
import { createProjectShiftRegistry } from "./registry";

const interruptedReason =
  "The private attempt owner could not be confirmed. Its input was not resent. Use the original shift's recovery controls.";
function unavailable(): never {
  throw new ConversationError(
    503,
    "This original shift attempt's private history could not be verified. Its saved data has been kept; no input was resent.",
  );
}
const same = (left: unknown, right: unknown) =>
  canonicalSessionInput(left) === canonicalSessionInput(right);

/** Strict original-to-index-to-user correlation, before any private page or feed is returned. */
function verifiedState(
  intent: ProjectShiftIntent,
  record: OwnedCodingSessionRecord,
  state: ConversationState,
): ConversationState {
  const user = state.frames[0]?.event;
  const snapshot = user?.kind === "user" ? user.shift : undefined;
  if (
    !snapshot ||
    user?.kind !== "user" ||
    user.session ||
    user.codexTask ||
    user.brief ||
    state.keeperRecovery ||
    intent.attemptedAt === null ||
    !intent.executionStartedAt ||
    state.turns.length !== 1 ||
    state.turns[0]?.requestId !== record.requestId ||
    state.frames.some((frame) => frame.turnId !== record.requestId) ||
    state.frames.filter((frame) => frame.event.kind === "user").length !== 1 ||
    snapshot.conversationId !== record.id ||
    snapshot.turnId !== record.requestId ||
    snapshot.provider !== record.provider ||
    snapshot.workspace !== record.workspace ||
    snapshot.cwd !== record.worktree ||
    record.repository !== intent.workspace ||
    snapshot.beadId !== record.beadId ||
    snapshot.smith !== record.smith ||
    snapshot.requestedModel !== record.requestedModel ||
    snapshot.requestedEffort !== record.requestedEffort ||
    user.text !== snapshot.stdin ||
    !same(user.about, [
      { kind: "bead", id: snapshot.beadId },
      { kind: "run", id: snapshot.runId },
    ])
  )
    unavailable();
  const input: PrivateExecInput = {
    provider: snapshot.provider,
    beadId: snapshot.beadId,
    runId: snapshot.runId,
    workspace: snapshot.workspace,
    cwd: snapshot.cwd,
    smith: {
      name: snapshot.smith,
      provider: snapshot.provider,
      model: snapshot.requestedModel,
      effort: snapshot.requestedEffort,
      enabled: true,
      tags: [],
    },
    command: snapshot.command,
    stdin: snapshot.stdin,
    timeoutMs: snapshot.timeoutMs,
  };
  try {
    if (
      record.requestId !==
        shiftAttemptRequestId(intent, input, snapshot.attempt) ||
      record.requestHash !==
        shiftAttemptHash(
          intent,
          input,
          snapshot.attempt,
          snapshot.cliVersion,
        ) ||
      !same(
        record.origin,
        shiftAttemptOrigin(intent, input, snapshot.attempt),
      ) ||
      !same(
        snapshot,
        prepareShiftTurnSnapshot(
          intent,
          input,
          snapshot.attempt,
          snapshot.cliVersion,
          record.id,
        ),
      )
    )
      unavailable();
  } catch {
    unavailable();
  }
  const processes = state.frames.filter(
    (frame) => frame.event.kind === "process",
  );
  const identities = state.frames.filter(
    (frame) => frame.event.kind === "identity",
  );
  if (
    processes.length > 1 ||
    processes.some(
      ({ event }) =>
        event.kind !== "process" ||
        event.smith !== snapshot.smith ||
        event.requestedModel !== snapshot.requestedModel ||
        event.requestedEffort !== snapshot.requestedEffort,
    ) ||
    (state.binding
      ? !processes.length ||
        !identities.length ||
        state.binding.provider !== snapshot.provider ||
        state.binding.version !== snapshot.cliVersion ||
        identities.some(
          ({ event }) =>
            event.kind !== "identity" ||
            !same(
              {
                provider: event.provider,
                sessionId: event.sessionId,
                version: event.version,
              },
              state.binding,
            ),
        )
      : identities.length > 0)
  )
    unavailable();
  if (state.turns[0]?.phase === "completed") {
    const outcome = state.frames.at(-1)?.event;
    if (
      !state.binding ||
      outcome?.kind !== "coding-outcome" ||
      outcome.code !== "completed" ||
      outcome.exitCode !== 0 ||
      outcome.provider !== snapshot.provider ||
      outcome.version !== snapshot.cliVersion
    )
      unavailable();
  }
  return state;
}

/** Observes the actual private owner lease without taking over, changing history or authorizing process control. */
export function createProjectShiftAttemptReader(options: {
  home: string;
  root: string;
}) {
  const originals = createProjectShiftRegistry(options);
  const registry = createSessionRegistry(options.home);
  const belongs = (
    intent: ProjectShiftIntent,
    record: OwnedCodingSessionRecord,
  ) => {
    const origin = record.origin;
    if (
      !origin ||
      origin.kind !== "shift" ||
      origin.projectId !== intent.projectId ||
      origin.originalRequestId !== intent.request.requestId ||
      origin.shiftId !== intent.shiftId ||
      workspaceKey(record.workspace) !== workspaceKey(intent.workspace) ||
      workspaceKey(record.repository) !== workspaceKey(intent.workspace)
    )
      throw new ConversationError(
        409,
        "This private attempt belongs to a different original shift, project or workspace.",
      );
  };
  return {
    list(projectId: string, requestId: string): ProjectShiftAttemptsPage {
      const intent = originals.read(projectId, requestId);
      const page: ProjectShiftAttemptsPage = {
        projectId,
        originalRequestId: requestId,
        shiftId: intent.shiftId,
        asOf: new Date().toISOString(),
        items: registry
          .listAll(projectId)
          .filter((record) => {
            try {
              belongs(intent, record);
              return true;
            } catch {
              return false;
            }
          })
          .map((session) => ({
            session,
            phase: "unknown",
            reason: SHIFT_ATTEMPT_METADATA_REASON,
            controllable: false,
          })),
      };
      if (
        !projectShiftAttemptsPageSchema.safeParse(page).success ||
        Buffer.byteLength(JSON.stringify(page)) > 2_097_152
      )
        unavailable();
      return page;
    },
    async read(
      projectId: string,
      requestId: string,
      sessionId: string,
      query: ConversationPageQuery = {},
    ) {
      validateConversationPageQuery(query);
      if (
        query.requestId !== undefined &&
        !sessionRequestIdSchema.safeParse(query.requestId).success
      )
        throw new ConversationError(
          400,
          "Expected an original private turn request UUID.",
        );
      const intent = originals.read(projectId, requestId),
        record = registry.lookup(projectId, sessionId);
      belongs(intent, record);
      const address = { kind: "session" as const, projectId, sessionId };
      const store = createConversationStore(options.home, undefined, address);
      const checked = () => {
        try {
          return verifiedState(intent, record, store.read(projectId));
        } catch {
          unavailable();
        }
      };
      let state = checked();
      if (
        state.turns.some((turn) =>
          ["accepted", "running", "cancelling"].includes(turn.phase),
        )
      ) {
        let live = false;
        let lease: string | undefined;
        try {
          const path = conversationLeaseFile(options.home, projectId, address),
            found = lstatSync(path);
          if (
            !found.isFile() ||
            found.isSymbolicLink() ||
            found.nlink !== 1 ||
            readHomeFile(path).problem !== null
          )
            throw Error("Unavailable private owner");
          lease = path;
        } catch {
          /* Missing or unverifiable ownership stays unknown. */
        }
        if (lease) {
          const result = await withQueueLock(lease, async () => checked(), {
            waitMs: 150,
          });
          state = result.ok ? result.value : checked();
          live = !result.ok && result.reason === "busy";
        }
        if (!live)
          state = {
            ...state,
            turns: state.turns.map((turn) =>
              ["accepted", "running", "cancelling"].includes(turn.phase)
                ? { ...turn, phase: "unknown", reason: interruptedReason }
                : turn,
            ),
          };
      }
      return conversationPage(state, query, false);
    },
  };
}
