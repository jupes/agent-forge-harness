import { createHash } from "node:crypto";
import type { CodexChatLaunch } from "../../types/codex-chat";
import type {
  CodexChatDecisionIntent,
  CodexChatDecisionRequest,
  CodexChatOwnedMetadata,
  CodexChatOwnedRecord,
  CodexChatStartReceipt,
} from "../../types/codex-owned-chat";
import type { ConversationObject } from "../../types/conversation";
import type { SessionMessage } from "../../types/session-turn";
import { ConversationError } from "../conversations/error";
import { createConversationService } from "../conversations/service";
import { createConversationStore } from "../conversations/store";
import type { ConversationUpdate } from "../conversations/transport";
import {
  type InitialStartAttempt,
  markKnownPreacceptPreparationRefusal,
} from "../identities/preaccept-not-sent-proof";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { preparedCodexChatSchema } from "./codex-app-server-protocol";
import { createCodexChatApprovalBroker } from "./codex-chat-approval-broker";
import {
  codexChatStartSchema,
  parseCodexChatDecision,
} from "./codex-chat-owned-protocol";
import { createCodexChatOwnedTransport } from "./codex-chat-owned-transport";
import type { createCodexChatRuntime } from "./codex-chat-runtime";
import { canonicalOwnedSessionStart } from "./codex-owned-protocol";
import { canonicalSessionInput } from "./preparation";
import { createSessionRegistry } from "./registry";

interface Options {
  root: string;
  home: string;
  runtime: ReturnType<typeof createCodexChatRuntime>;
  validateScope(
    projectId: string,
    metadata: Pick<
      CodexChatOwnedMetadata,
      "workspace" | "repository" | "worktree" | "beadId"
    >,
    about: ConversationObject[],
  ): Promise<void>;
  onChange?(session: CodexChatOwnedRecord, update: ConversationUpdate): void;
  onApprovalChange?(sessionId: string): void;
}
/** Additive app-server Chat over the existing owned registry, dispatch lease and private journal. */
export function createCodexOwnedChatService(options: Options) {
  const registry = createSessionRegistry(options.home, "codex", "chat"),
    workspace = workspaceKey(resolveCheckout(options.root).workspace);
  const services = new Map<
      string,
      ReturnType<typeof createConversationService>
    >(),
    initial = new Map<string, CodexChatLaunch>();
  let closed = false;
  const checked = (projectId: string, sessionId: string) => {
    const session = registry.read(projectId, sessionId);
    if (workspaceKey(session.workspace) !== workspace)
      throw new ConversationError(
        409,
        "This owned Chat belongs to another workspace.",
      );
    return session;
  };
  const address = (session: CodexChatOwnedRecord) => ({
    kind: "session" as const,
    projectId: session.projectId,
    sessionId: session.id,
  });
  const storeFor = (session: CodexChatOwnedRecord) =>
    createConversationStore(options.home, undefined, address(session));
  const broker = createCodexChatApprovalBroker({
    readIntents(selected) {
      const session = checked(selected.projectId, selected.sessionId);
      return storeFor(session)
        .read(session.projectId)
        .frames.flatMap(({ event }): CodexChatDecisionIntent[] =>
          event.kind === "coding-chat-decision" ? [event] : [],
        );
    },
    onChange: (selected) => options.onApprovalChange?.(selected.sessionId),
  });
  const serviceFor = (session: CodexChatOwnedRecord) => {
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
      transport: createCodexChatOwnedTransport(
        options.runtime,
        broker,
        address(session),
      ),
      validateAbout: (projectId, about) =>
        options.validateScope(projectId, session, about),
      async prepareCodexChat({ input, resume }) {
        const saved = storeFor(session).read(session.projectId);
        if (saved.turns.length && !resume)
          throw new ConversationError(
            409,
            "This Chat has no confirmed native identity. Its previous turn was not resent.",
          );
        const first = saved.frames.find(
          (frame) => frame.event.kind === "user" && frame.event.codexChat,
        )?.event;
        const template =
          first?.kind === "user"
            ? first.codexChat?.launch
            : initial.get(session.id);
        if (
          !template ||
          template.mode !== "chat" ||
          template.model !== session.requestedModel ||
          (template.effort ?? null) !== session.requestedEffort ||
          template.cwd !== session.worktree
        )
          throw new ConversationError(
            409,
            "The private Chat does not match its immutable original selection. No turn was accepted.",
          );
        const attachments = input.attachments?.map((item) => {
          if (item.kind !== "text")
            throw new ConversationError(
              400,
              "Codex Chat image staging is unavailable.",
            );
          return { kind: "text" as const, name: item.name, text: item.text };
        });
        const { attachments: _originalAttachments, ...selection } = template;
        const launch: CodexChatLaunch = {
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
        } catch (error) {
          throw markKnownPreacceptPreparationRefusal(
            new ConversationError(
              503,
              "The selected Codex Chat options are unavailable or lack exact capability evidence. No turn was accepted.",
            ),
            error,
          );
        }
        const parsed = preparedCodexChatSchema.safeParse(raw);
        if (
          !parsed.success ||
          parsed.data.smith !== session.smith ||
          parsed.data.cwd !== session.worktree ||
          (first?.kind === "user" &&
            first.codexChat &&
            parsed.data.canonicalCwd !== first.codexChat.canonicalCwd) ||
          canonicalSessionInput(parsed.data.launch) !==
            canonicalSessionInput(launch)
        )
          throw new ConversationError(
            503,
            "The prepared Chat changed the reviewed input. No turn was accepted.",
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
      attempt?: InitialStartAttempt,
    ): Promise<CodexChatStartReceipt> {
      const parsed = codexChatStartSchema.safeParse(raw);
      if (!parsed.success)
        throw new ConversationError(
          400,
          "Expected an explicit bounded Codex Chat Start request.",
        );
      const request = parsed.data;
      if (closed)
        throw new ConversationError(
          503,
          "This hearth is closing. No Chat turn was accepted.",
        );
      const hash = createHash("sha256")
        .update(canonicalOwnedSessionStart(request))
        .digest("hex");
      const session = await registry.reserve(
        projectId,
        request.requestId,
        hash,
        async () => {
          const metadata: CodexChatOwnedMetadata = {
            provider: "codex",
            mode: "chat",
            workspace: resolveCheckout(options.root).workspace,
            repository: request.repository,
            worktree: request.worktree,
            ...(request.beadId ? { beadId: request.beadId } : {}),
            smith: request.smith,
            requestedModel: request.launch.model,
            requestedEffort: request.launch.effort ?? null,
          };
          await options.validateScope(projectId, metadata, request.about ?? []);
          return metadata;
        },
      );
      const { effort, attachments, ...selection } = request.launch;
      initial.set(session.id, {
        ...selection,
        ...(effort === undefined ? {} : { effort }),
        ...(attachments === undefined ? {} : { attachments }),
        cwd: session.worktree,
      });
      try {
        return {
          session,
          receipt: await serviceFor(session).send(
            projectId,
            {
              requestId: request.requestId,
              expectedRevision: 0,
              text: request.launch.prompt,
              about: request.about ?? [],
              attachments: request.launch.attachments,
            },
            "message",
            attempt,
          ),
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
        selected = { projectId, sessionId };
      const page = broker.read(selected, requestId);
      // Reconciliation is history, not fresh execution authority. Pending callbacks
      // are advertised only while their current project/worktree scope still passes.
      if (requestId !== undefined)
        return { pending: [], receipt: page.receipt };
      if (!page.pending.length) return page;
      const state = storeFor(session).read(projectId),
        turnId = page.pending[0]?.turnRequestId;
      const user = state.frames.find(
        (frame) => frame.turnId === turnId && frame.event.kind === "user",
      )?.event;
      if (user?.kind !== "user")
        throw new ConversationError(
          409,
          "The live approval has no matching private accepted turn.",
        );
      await options.validateScope(projectId, session, user.about);
      // Native resolution/Stop may have arrived while the read-only scope check waited.
      return broker.read(selected, requestId);
    },
    async decide(
      projectId: string,
      sessionId: string,
      raw: CodexChatDecisionRequest,
    ) {
      const session = checked(projectId, sessionId),
        request = parseCodexChatDecision(raw),
        selected = { projectId, sessionId };
      // An original recorded receipt is reconciled before mutable scope checks; it never reopens a callback.
      if (broker.read(selected, request.requestId).receipt)
        return broker.decide(selected, request);
      const state = storeFor(session).read(projectId),
        user = state.frames.find(
          (frame) =>
            frame.turnId === request.turnRequestId &&
            frame.event.kind === "user",
        )?.event;
      await options.validateScope(
        projectId,
        session,
        user?.kind === "user" ? user.about : [],
      );
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
