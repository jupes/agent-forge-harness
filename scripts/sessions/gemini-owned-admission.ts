import { createHash } from "node:crypto";
import type { ConversationObject } from "../../types/conversation";
import type {
  GeminiOwnedSessionMetadata,
  GeminiOwnedSessionRecord,
  GeminiTaskStartReceipt,
} from "../../types/gemini-owned-task";
import type { GeminiTaskLaunch } from "../../types/gemini-task";
import type { SessionMessage } from "../../types/session-turn";
import { ConversationError } from "../conversations/error";
import { createConversationService } from "../conversations/service";
import { createConversationStore } from "../conversations/store";
import type { ConversationUpdate } from "../conversations/transport";
import type { InitialStartAttempt } from "../identities/preaccept-not-sent-proof";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import {
  canonicalOwnedSessionStart,
  parseOwnedSessionStart,
} from "./codex-owned-protocol";
import {
  geminiTaskLaunchFromStart,
  prepareReviewedGeminiTask,
} from "./gemini-owned-preparation";
import { createGeminiOwnedTransport } from "./gemini-owned-transport";
import type { createGeminiTaskRuntime } from "./gemini-task-runtime";
import { requireOrdinarySession } from "./managed-origin";
import { createSessionRegistry } from "./registry";

/** The existing locked registry and durable conversation lease own admission and exact retries. */
export function createGeminiOwnedTaskService(options: {
  root: string;
  home: string;
  runtime: ReturnType<typeof createGeminiTaskRuntime>;
  validateScope(
    projectId: string,
    metadata: Pick<
      GeminiOwnedSessionMetadata,
      "workspace" | "repository" | "worktree" | "beadId"
    >,
    about: ConversationObject[],
  ): Promise<void>;
  onChange?(
    session: GeminiOwnedSessionRecord,
    update: ConversationUpdate,
  ): void;
}) {
  const registry = createSessionRegistry(options.home, "gemini"),
    workspace = workspaceKey(resolveCheckout(options.root).workspace),
    transport = createGeminiOwnedTransport(options.runtime),
    services = new Map<string, ReturnType<typeof createConversationService>>(),
    initial = new Map<string, GeminiTaskLaunch>();
  let closed = false;
  const serviceFor = (session: GeminiOwnedSessionRecord) => {
    requireOrdinarySession(session);
    if (workspaceKey(session.workspace) !== workspace)
      throw new ConversationError(
        409,
        "This owned Task belongs to another workspace.",
      );
    const found = services.get(session.id);
    if (found) return found;
    if (closed)
      throw new ConversationError(
        503,
        "This hearth is closing. No Task was accepted.",
      );
    const address = {
      kind: "session" as const,
      projectId: session.projectId,
      sessionId: session.id,
    };
    const service = createConversationService({
      root: options.root,
      home: options.home,
      address,
      transport,
      validateAbout: (projectId, about) =>
        options.validateScope(projectId, session, about),
      async prepareGeminiTask({ input, resume }) {
        const saved = createConversationStore(
          options.home,
          undefined,
          address,
        ).read(session.projectId);
        if (saved.turns.length || resume)
          throw new ConversationError(
            409,
            "This Gemini Task already has its one accepted turn. Start another session explicitly.",
          );
        const template = initial.get(session.id);
        if (!template || (template.model ?? null) !== session.requestedModel)
          throw new ConversationError(
            409,
            "The original private Gemini Task is unavailable or changed. Check the original Start request.",
          );
        const attachments = input.attachments?.map((attachment) => {
          if (attachment.kind !== "text")
            throw new ConversationError(
              400,
              "Gemini Task image staging is unavailable.",
            );
          return {
            kind: "text" as const,
            name: attachment.name,
            text: attachment.text,
          };
        });
        const launch: GeminiTaskLaunch = {
          ...template,
          prompt: input.text,
          ...(attachments === undefined ? {} : { attachments }),
          context: {
            projectId: session.projectId,
            repository: session.repository,
            worktree: session.worktree,
            ...(session.beadId ? { beadId: session.beadId } : {}),
            about: input.about,
          },
        };
        await options.validateScope(session.projectId, session, input.about);
        const snapshot = await prepareReviewedGeminiTask(options.runtime, {
          smith: session.smith,
          launch,
        });
        await options.validateScope(session.projectId, session, input.about);
        return snapshot;
      },
      onChange: (update) => options.onChange?.(session, update),
    });
    services.set(session.id, service);
    return service;
  };
  const forId = (projectId: string, sessionId: string) =>
    serviceFor(registry.read(projectId, sessionId));
  return {
    async start(
      projectId: string,
      raw: unknown,
      attempt?: InitialStartAttempt,
    ): Promise<GeminiTaskStartReceipt> {
      const request = parseOwnedSessionStart(raw);
      if (
        !("provider" in request) ||
        request.provider !== "gemini" ||
        request.launch.mode !== "task"
      )
        throw new ConversationError(
          400,
          "An explicit Gemini CLI Task provider is required.",
        );
      if (closed)
        throw new ConversationError(
          503,
          "This hearth is closing. No Task was accepted.",
        );
      const hash = createHash("sha256")
        .update(canonicalOwnedSessionStart(request))
        .digest("hex");
      const session = await registry.reserve(
        projectId,
        request.requestId,
        hash,
        async () => {
          const metadata: GeminiOwnedSessionMetadata = {
            provider: "gemini",
            route: "gemini-cli",
            mode: "task",
            workspace: resolveCheckout(options.root).workspace,
            repository: request.repository,
            worktree: request.worktree,
            ...(request.beadId ? { beadId: request.beadId } : {}),
            smith: request.smith,
            requestedModel: request.launch.model ?? null,
            requestedEffort: null,
          };
          await options.validateScope(projectId, metadata, request.about ?? []);
          if (!attempt) {
            try {
              await options.runtime.check({ smith: request.smith });
            } catch {
              throw new ConversationError(
                503,
                "The selected Gemini smith is unavailable. No Task was reserved.",
              );
            }
          }
          await options.validateScope(projectId, metadata, request.about ?? []);
          return metadata;
        },
      );
      initial.set(
        session.id,
        geminiTaskLaunchFromStart(projectId, {
          ...request,
          launch: { ...request.launch, mode: "task" },
        }),
      );
      try {
        const receipt = await serviceFor(session).send(
          projectId,
          {
            requestId: request.requestId,
            expectedRevision: 0,
            text: request.launch.prompt,
            about: request.about ?? [],
            attachments: request.launch.attachments?.map((item) => ({
              ...item,
            })),
          },
          "message",
          attempt,
        );
        return { session, receipt };
      } finally {
        initial.delete(session.id);
      }
    },
    async send(projectId: string, sessionId: string, _input: SessionMessage) {
      requireOrdinarySession(registry.read(projectId, sessionId));
      throw new ConversationError(
        409,
        "Gemini Task sessions accept one turn. Start another Task explicitly.",
      );
    },
    read(
      projectId: string,
      sessionId: string,
      query: { after?: number; limit?: number; requestId?: string } = {},
    ) {
      return forId(projectId, sessionId).read(projectId, query);
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
