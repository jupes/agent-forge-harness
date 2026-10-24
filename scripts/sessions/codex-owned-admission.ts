import { createHash } from "node:crypto";
import type {
  CodexOwnedSessionMetadata,
  CodexOwnedSessionRecord,
  CodexTaskStartReceipt,
} from "../../types/codex-owned-task";
import type { CodexTaskLaunch } from "../../types/codex-task";
import type { ConversationObject } from "../../types/conversation";
import type { SessionMessage } from "../../types/session-turn";
import { ConversationError } from "../conversations/error";
import { createConversationService } from "../conversations/service";
import { createConversationStore } from "../conversations/store";
import type { ConversationUpdate } from "../conversations/transport";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import {
  canonicalOwnedSessionStart,
  parseOwnedSessionStart,
} from "./codex-owned-protocol";
import { createCodexOwnedTransport } from "./codex-owned-transport";
import type { createCodexTaskRuntime } from "./codex-task-runtime";
import { preparedCodexTaskSchema } from "./codex-task-runtime-protocol";
import { requireOrdinarySession } from "./managed-origin";
import { canonicalSessionInput } from "./preparation";
import { createSessionRegistry } from "./registry";

type ScopeMetadata = Pick<
  CodexOwnedSessionMetadata,
  "workspace" | "repository" | "worktree" | "beadId"
>;
interface Options {
  root: string;
  home: string;
  runtime: ReturnType<typeof createCodexTaskRuntime>;
  validateScope(
    projectId: string,
    metadata: ScopeMetadata,
    about: ConversationObject[],
  ): Promise<void>;
  onChange?(session: CodexOwnedSessionRecord, update: ConversationUpdate): void;
}
/** Explicit Task-only provider branch over the existing owned lease/journal, never a Claude conversion. */
export function createCodexOwnedTaskService(options: Options) {
  const registry = createSessionRegistry(options.home, "codex");
  const workspace = workspaceKey(resolveCheckout(options.root).workspace);
  const transport = createCodexOwnedTransport(options.runtime);
  const services = new Map<
    string,
    ReturnType<typeof createConversationService>
  >();
  const initial = new Map<string, CodexTaskLaunch>();
  let closed = false;
  const serviceFor = (session: CodexOwnedSessionRecord) => {
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
      async prepareCodexTask({ input, resume }) {
        const saved = createConversationStore(
          options.home,
          undefined,
          address,
        ).read(session.projectId);
        if (saved.turns.length || resume)
          throw new ConversationError(
            409,
            "This Codex Task already has its one accepted turn. Start another session explicitly.",
          );
        const template = initial.get(session.id);
        if (!template)
          throw new ConversationError(
            409,
            "The original private Task is unavailable. Check the original Start request.",
          );
        if (
          template.mode !== session.mode ||
          template.model !== session.requestedModel ||
          (template.effort ?? null) !== session.requestedEffort
        )
          throw new ConversationError(
            409,
            "The private Codex Task differs from the original requested selection. No Task was started.",
          );
        const attachments = input.attachments?.map((attachment) => {
          if (attachment.kind !== "text")
            throw new ConversationError(
              400,
              "Codex Task image staging is unavailable.",
            );
          return {
            kind: "text" as const,
            name: attachment.name,
            text: attachment.text,
          };
        });
        const launch: CodexTaskLaunch = {
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
        const reviewed = structuredClone({ smith: session.smith, launch });
        let raw: unknown;
        try {
          raw = await options.runtime.prepare(structuredClone(reviewed));
        } catch {
          throw new ConversationError(
            503,
            "The selected Codex Task options are unavailable or lack exact capability evidence. No turn was accepted.",
          );
        }
        const parsed = preparedCodexTaskSchema.safeParse(raw);
        if (
          !parsed.success ||
          parsed.data.smith !== reviewed.smith ||
          parsed.data.cwd !== session.worktree ||
          canonicalSessionInput(parsed.data.launch) !==
            canonicalSessionInput(reviewed.launch)
        )
          throw new ConversationError(
            503,
            "The prepared Codex Task changed the reviewed input. No turn was accepted.",
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
    serviceFor(registry.read(projectId, sessionId));
  return {
    async start(
      projectId: string,
      raw: unknown,
    ): Promise<CodexTaskStartReceipt> {
      const request = parseOwnedSessionStart(raw);
      if (
        !("provider" in request) ||
        request.provider !== "codex" ||
        request.launch.mode !== "task"
      )
        throw new ConversationError(
          400,
          "An explicit Codex Task provider is required.",
        );
      if (closed)
        throw new ConversationError(
          503,
          "This hearth is closing. No Task was accepted.",
        );
      const requestHash = createHash("sha256")
        .update(canonicalOwnedSessionStart(request))
        .digest("hex");
      const session = await registry.reserve(
        projectId,
        request.requestId,
        requestHash,
        async () => {
          const metadata: CodexOwnedSessionMetadata = {
            provider: "codex",
            mode: "task",
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
      const launch: CodexTaskLaunch = {
        mode: "task",
        cwd: session.worktree,
        model: request.launch.model,
        prompt: request.launch.prompt,
        sandbox: request.launch.sandbox,
        approvalPolicy: request.launch.approvalPolicy,
        ...(request.launch.effort === undefined
          ? {}
          : { effort: request.launch.effort }),
        ...(request.launch.attachments === undefined
          ? {}
          : { attachments: structuredClone(request.launch.attachments) }),
      };
      initial.set(session.id, launch);
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
    async send(projectId: string, sessionId: string, _input: SessionMessage) {
      requireOrdinarySession(registry.read(projectId, sessionId));
      throw new ConversationError(
        409,
        "Codex Task sessions accept one turn. Start another Task explicitly.",
      );
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
        .filter(
          (session) =>
            !session.origin && workspaceKey(session.workspace) === workspace,
        );
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
