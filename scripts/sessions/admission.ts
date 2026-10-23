import { createHash } from "node:crypto";
import type { ConversationObject } from "../../types/conversation";
import type {
  OwnedSessionMetadata,
  OwnedSessionRecord,
} from "../../types/owned-session";
import type { ClaudeSessionLaunch } from "../../types/session-launch";
import type { SessionStartReceipt } from "../../types/session-requests";
import type {
  SessionMessage,
  SessionTurnSnapshot,
} from "../../types/session-turn";
import { ConversationError } from "../conversations/error";
import { parseSessionSend } from "../conversations/protocol";
import { createConversationService } from "../conversations/service";
import { createConversationStore } from "../conversations/store";
import type {
  ConversationTransport,
  ConversationUpdate,
} from "../conversations/transport";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { canonicalSessionInput, prepareReviewedSession } from "./preparation";
import { createSessionRegistry } from "./registry";
import { parseSessionStart } from "./request-protocol";

export interface SessionRuntime extends ConversationTransport {
  prepare(input: {
    smith: string;
    cwd: string;
    launch: ClaudeSessionLaunch;
  }): Promise<SessionTurnSnapshot>;
}
interface Options {
  root: string;
  home: string;
  runtime: SessionRuntime;
  /** Current catalog, registered worktree and optional bead/context checks; never caller authority. */
  validateScope(
    projectId: string,
    metadata: OwnedSessionMetadata,
    about: ConversationObject[],
    launch?: ClaudeSessionLaunch,
  ): Promise<void>;
  onChange?(session: OwnedSessionRecord, update: ConversationUpdate): void;
}

/** The registry fixes Start identity; only the private journal can authorize dispatch. */
export function createOwnedSessionService(options: Options) {
  const registry = createSessionRegistry(options.home);
  const workspace = workspaceKey(resolveCheckout(options.root).workspace);
  const services = new Map<
    string,
    ReturnType<typeof createConversationService>
  >();
  const initial = new Map<string, ClaudeSessionLaunch>();
  let closed = false;
  const address = (session: OwnedSessionRecord) => ({
    kind: "session" as const,
    projectId: session.projectId,
    sessionId: session.id,
  });
  const serviceFor = (session: OwnedSessionRecord) => {
    if (workspaceKey(session.workspace) !== workspace)
      throw new ConversationError(
        409,
        "This owned session belongs to a different workspace. Open its hearth to read or control it.",
      );
    const found = services.get(session.id);
    if (found) return found;
    if (closed)
      throw new ConversationError(
        503,
        "This hearth is closing. No new session was accepted.",
      );
    const selected = address(session);
    const service = createConversationService({
      root: options.root,
      home: options.home,
      address: selected,
      transport: options.runtime,
      validateAbout: (projectId, about) =>
        options.validateScope(projectId, session, about),
      async prepareSession({ input, resume }) {
        const saved = createConversationStore(
          options.home,
          undefined,
          selected,
        ).read(session.projectId);
        if (session.mode === "task" && saved.turns.length)
          throw new ConversationError(
            409,
            "This Task already has its one accepted turn. Start another session explicitly.",
          );
        if (saved.turns.length && !resume)
          throw new ConversationError(
            409,
            "This Chat has no confirmed provider identity. Its previous turn was not resent.",
          );
        const first = saved.frames.find(
          (frame) => frame.event.kind === "user" && frame.event.session,
        )?.event;
        const template =
          first?.kind === "user"
            ? first.session?.launch
            : initial.get(session.id);
        if (!template)
          throw new ConversationError(
            409,
            "The original private launch is unavailable. Check the original Start request.",
          );
        if (
          template.mode !== session.mode ||
          template.model !== session.requestedModel ||
          (template.effort ?? null) !== session.requestedEffort
        )
          throw new ConversationError(
            409,
            "The private launch does not match the original session selection. It was not dispatched.",
          );
        const launch: ClaudeSessionLaunch = {
          ...template,
          prompt: input.text,
          attachments: input.attachments,
          ...(resume ? { resumeSessionId: resume.sessionId } : {}),
          context: {
            projectId: session.projectId,
            repository: session.repository,
            worktree: session.worktree,
            ...(session.beadId ? { beadId: session.beadId } : {}),
            about: input.about,
          },
        };
        await options.validateScope(
          session.projectId,
          session,
          input.about,
          launch,
        );
        return prepareReviewedSession(options.runtime, {
          smith: session.smith,
          cwd: session.worktree,
          launch,
        });
      },
      onChange: (update) => options.onChange?.(session, update),
    });
    services.set(session.id, service);
    return service;
  };
  const forId = (projectId: string, sessionId: string) =>
    serviceFor(registry.read(projectId, sessionId));
  return {
    async start(projectId: string, raw: unknown): Promise<SessionStartReceipt> {
      const request = parseSessionStart(raw);
      if (closed)
        throw new ConversationError(
          503,
          "This hearth is closing. No new session was accepted.",
        );
      const requestHash = createHash("sha256")
        .update(canonicalSessionInput(request))
        .digest("hex");
      const session = await registry.reserve(
        projectId,
        request.requestId,
        requestHash,
        async () => {
          const metadata: OwnedSessionMetadata = {
            mode: request.launch.mode,
            provider: "claude",
            workspace: resolveCheckout(options.root).workspace,
            repository: request.repository,
            worktree: request.worktree,
            ...(request.beadId ? { beadId: request.beadId } : {}),
            smith: request.smith,
            requestedModel: request.launch.model,
            requestedEffort: request.launch.effort ?? null,
          };
          await options.validateScope(
            projectId,
            metadata,
            request.about ?? [],
            request.launch,
          );
          return metadata;
        },
      );
      if (closed)
        throw new ConversationError(
          503,
          "This hearth is closing. No new session was accepted.",
        );
      initial.set(session.id, request.launch);
      try {
        const receipt = await serviceFor(session).send(projectId, {
          requestId: request.requestId,
          expectedRevision: 0,
          text: request.launch.prompt,
          about: request.about ?? [],
          attachments: request.launch.attachments,
        });
        return { session, receipt };
      } finally {
        initial.delete(session.id);
      }
    },
    async send(projectId: string, sessionId: string, raw: SessionMessage) {
      if (closed)
        throw new ConversationError(
          503,
          "This hearth is closing. No turn was accepted.",
        );
      const input = parseSessionSend(raw),
        session = registry.read(projectId, sessionId);
      if (session.mode !== "chat")
        throw new ConversationError(
          409,
          "Task sessions end after one turn. Start another session explicitly.",
        );
      return serviceFor(session).send(projectId, input);
    },
    read(
      projectId: string,
      sessionId: string,
      query: { after?: number; limit?: number; requestId?: string } = {},
    ) {
      return forId(projectId, sessionId).read(projectId, query);
    },
    list(projectId: string) {
      return registry
        .list(projectId)
        .filter((session) => workspaceKey(session.workspace) === workspace);
    },
    stop(projectId: string, sessionId: string, requestId: string) {
      return forId(projectId, sessionId).stop(projectId, requestId);
    },
    settled(projectId: string, sessionId: string) {
      return forId(projectId, sessionId).settled(projectId);
    },
    async close() {
      closed = true;
      await Promise.all(
        [...services.values()].map((service) => service.close()),
      );
      initial.clear();
    },
  };
}
