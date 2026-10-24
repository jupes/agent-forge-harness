import { createHash } from "node:crypto";
import type { ConversationObject } from "../../types/conversation";
import type { GeminiChatLaunch } from "../../types/gemini-chat-runtime";
import type {
  GeminiChatDecisionIntent,
  GeminiChatDecisionRequest,
  GeminiChatOwnedMetadata,
  GeminiChatOwnedRecord,
  GeminiChatStartReceipt,
} from "../../types/gemini-owned-chat";
import type { SessionMessage } from "../../types/session-turn";
import { ConversationError } from "../conversations/error";
import { createConversationService } from "../conversations/service";
import { createConversationStore } from "../conversations/store";
import type { ConversationUpdate } from "../conversations/transport";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { canonicalOwnedSessionStart } from "./codex-owned-protocol";
import { createGeminiChatApprovalBroker } from "./gemini-chat-approval-broker";
import {
  geminiChatStartSchema,
  parseGeminiChatDecision,
} from "./gemini-chat-owned-protocol";
import { createGeminiChatOwnedTransport } from "./gemini-chat-owned-transport";
import type { createGeminiChatRuntime } from "./gemini-chat-runtime";
import { preparedGeminiChatSchema } from "./gemini-chat-runtime-protocol";
import { requireOrdinarySession } from "./managed-origin";
import { canonicalSessionInput } from "./preparation";
import { createSessionRegistry } from "./registry";

/** Dedicated ACP admission; the existing lease/private journal retain original and dispatch authority. */
export function createGeminiOwnedChatService(options: {
  root: string;
  home: string;
  runtime: ReturnType<typeof createGeminiChatRuntime>;
  validateScope(
    projectId: string,
    metadata: Pick<
      GeminiChatOwnedMetadata,
      "workspace" | "repository" | "worktree" | "beadId"
    >,
    about: ConversationObject[],
  ): Promise<void>;
  onChange?(session: GeminiChatOwnedRecord, update: ConversationUpdate): void;
  onApprovalChange?(sessionId: string): void;
}) {
  const registry = createSessionRegistry(options.home, "gemini", "chat"),
    workspace = workspaceKey(resolveCheckout(options.root).workspace);
  const services = new Map<
      string,
      ReturnType<typeof createConversationService>
    >(),
    initial = new Map<string, GeminiChatLaunch>();
  let closed = false;
  const checked = (projectId: string, sessionId: string) => {
    const session = registry.read(projectId, sessionId);
    requireOrdinarySession(session);
    if (workspaceKey(session.workspace) !== workspace)
      throw new ConversationError(
        409,
        "This owned Chat belongs to another workspace.",
      );
    return session;
  };
  const address = (session: GeminiChatOwnedRecord) => ({
    kind: "session" as const,
    projectId: session.projectId,
    sessionId: session.id,
  });
  const storeFor = (session: GeminiChatOwnedRecord) =>
    createConversationStore(options.home, undefined, address(session));
  const broker = createGeminiChatApprovalBroker({
    readIntents(selected) {
      const session = checked(selected.projectId, selected.sessionId);
      return storeFor(session)
        .read(session.projectId)
        .frames.flatMap(({ event }): GeminiChatDecisionIntent[] =>
          event.kind === "coding-gemini-chat-decision" ? [event] : [],
        );
    },
    onChange: (selected) => options.onApprovalChange?.(selected.sessionId),
  });
  const serviceFor = (session: GeminiChatOwnedRecord) => {
    checked(session.projectId, session.id);
    const existing = services.get(session.id);
    if (existing) return existing;
    if (closed)
      throw new ConversationError(
        503,
        "This hearth is closing. No Chat turn was accepted.",
      );
    const service = createConversationService({
      root: options.root,
      home: options.home,
      address: address(session),
      transport: createGeminiChatOwnedTransport(
        options.runtime,
        broker,
        address(session),
      ),
      validateAbout: (projectId, about) =>
        options.validateScope(projectId, session, about),
      async prepareGeminiChat({ input, resume }) {
        const saved = storeFor(session).read(session.projectId);
        if (
          saved.turns.length &&
          (!resume ||
            resume.provider !== "gemini" ||
            resume.version !== "0.65.0")
        )
          throw new ConversationError(
            409,
            "This Chat has no confirmed compatible native identity. Its previous turn was not resent.",
          );
        const first = saved.frames.find(
          (frame) => frame.event.kind === "user" && frame.event.geminiChat,
        )?.event;
        const template =
          first?.kind === "user"
            ? first.geminiChat?.launch
            : initial.get(session.id);
        if (
          !template ||
          template.mode !== "chat" ||
          (template.model ?? null) !== session.requestedModel ||
          template.cwd !== session.worktree
        )
          throw new ConversationError(
            409,
            "The private Gemini Chat does not match its immutable original selection. No turn was accepted.",
          );
        const attachments = input.attachments?.map((item) => {
          if (item.kind !== "text")
            throw new ConversationError(
              400,
              "Gemini Chat image staging is unavailable.",
            );
          return { kind: "text" as const, name: item.name, text: item.text };
        });
        const { attachments: _originalAttachments, ...selection } = template;
        const launch: GeminiChatLaunch = {
          ...selection,
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
        let raw: unknown;
        try {
          raw = await options.runtime.prepare({
            smith: session.smith,
            launch: structuredClone(launch),
          });
        } catch {
          throw new ConversationError(
            503,
            "The selected Gemini Chat options are unavailable or lack exact native capability evidence. No turn was accepted.",
          );
        }
        const parsed = preparedGeminiChatSchema.safeParse(raw);
        if (
          !parsed.success ||
          parsed.data.smith !== session.smith ||
          parsed.data.launch.cwd !== session.worktree ||
          (first?.kind === "user" &&
            first.geminiChat &&
            (parsed.data.canonicalCwd !== first.geminiChat.canonicalCwd ||
              parsed.data.canonicalRoot !== first.geminiChat.canonicalRoot ||
              parsed.data.capabilities.version !==
                first.geminiChat.capabilities.version)) ||
          canonicalSessionInput(parsed.data.launch) !==
            canonicalSessionInput(launch)
        )
          throw new ConversationError(
            503,
            "The prepared Gemini Chat changed the reviewed private input. No turn was accepted.",
          );
        await options.validateScope(session.projectId, session, input.about);
        return parsed.data;
      },
      onChange: (update) => options.onChange?.(session, update),
    });
    services.set(session.id, service);
    return service;
  };
  const forId = (projectId: string, sessionId: string) =>
    serviceFor(checked(projectId, sessionId));
  return {
    async start(
      projectId: string,
      raw: unknown,
    ): Promise<GeminiChatStartReceipt> {
      const parsed = geminiChatStartSchema.safeParse(raw);
      if (!parsed.success)
        throw new ConversationError(
          400,
          "Expected an explicit bounded Gemini ACP Chat Start request.",
        );
      if (closed)
        throw new ConversationError(
          503,
          "This hearth is closing. No Chat turn was accepted.",
        );
      const request = parsed.data,
        hash = createHash("sha256")
          .update(canonicalOwnedSessionStart(request))
          .digest("hex");
      const session = await registry.reserve(
        projectId,
        request.requestId,
        hash,
        async () => {
          const metadata: GeminiChatOwnedMetadata = {
            provider: "gemini",
            route: "gemini-cli",
            mode: "chat",
            workspace: resolveCheckout(options.root).workspace,
            repository: request.repository,
            worktree: request.worktree,
            ...(request.beadId ? { beadId: request.beadId } : {}),
            smith: request.smith,
            requestedModel: request.launch.model ?? null,
            requestedEffort: null,
          };
          await options.validateScope(projectId, metadata, request.about ?? []);
          return metadata;
        },
      );
      initial.set(session.id, { ...request.launch, cwd: session.worktree });
      try {
        return {
          session,
          receipt: await serviceFor(session).send(projectId, {
            requestId: request.requestId,
            expectedRevision: 0,
            text: request.launch.prompt,
            about: request.about ?? [],
            attachments: request.launch.attachments
              ? [...request.launch.attachments]
              : undefined,
          }),
        };
      } finally {
        initial.delete(session.id);
      }
    },
    send(projectId: string, sessionId: string, input: SessionMessage) {
      return forId(projectId, sessionId).send(projectId, input);
    },
    read(
      projectId: string,
      sessionId: string,
      query: { after?: number; limit?: number; requestId?: string } = {},
    ) {
      return forId(projectId, sessionId).read(projectId, query);
    },
    async approvals(projectId: string, sessionId: string, requestId?: string) {
      const session = checked(projectId, sessionId),
        selected = { projectId, sessionId },
        page = broker.read(selected, requestId);
      if (requestId !== undefined || !page.pending.length) return page;
      const state = storeFor(session).read(projectId);
      // Scope each returned offer's accepted original; re-read after every await before returning actionability.
      for (const pending of page.pending) {
        const user = state.frames.find(
          (frame) =>
            frame.turnId === pending.turnRequestId &&
            frame.event.kind === "user",
        )?.event;
        if (user?.kind !== "user")
          throw new ConversationError(
            409,
            "The live Gemini permission has no matching private original.",
          );
        await options.validateScope(projectId, session, user.about);
      }
      return broker.read(selected);
    },
    async decide(
      projectId: string,
      sessionId: string,
      raw: GeminiChatDecisionRequest,
    ) {
      const session = checked(projectId, sessionId),
        request = parseGeminiChatDecision(raw),
        selected = { projectId, sessionId };
      if (broker.read(selected, request.requestId).receipt)
        return broker.decide(selected, request);
      const user = storeFor(session)
        .read(projectId)
        .frames.find(
          (frame) =>
            frame.turnId === request.turnRequestId &&
            frame.event.kind === "user",
        )?.event;
      if (user?.kind !== "user")
        throw new ConversationError(
          409,
          "The Gemini permission has no matching private accepted original.",
        );
      await options.validateScope(projectId, session, user.about);
      return broker.decide(selected, request);
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
