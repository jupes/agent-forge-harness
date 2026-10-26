import { createHash } from "node:crypto";
import type { KeeperProposalExecution } from "../../types/keeper-proposal";
import type { KeeperSessionStartReceipt } from "../../types/keeper-session-start";
import type { SessionStartRequest } from "../../types/session-requests";
import type { SessionStartIdentityPage } from "../../types/session-start-identities";
import { ConversationError } from "../conversations/error";
import { createConversationStore } from "../conversations/store";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { createProjectStore } from "../projects/store";
import type { createOwnedSessionService } from "../sessions/admission";
import { canonicalOwnedSessionStart } from "../sessions/codex-owned-protocol";
import { sessionStartIdentityPageSchema } from "../sessions/identity-protocol";
import { canonicalSessionInput } from "../sessions/preparation";
import { sessionStartReceiptSchema } from "../sessions/protocol";
import { createKeeperProposalStore } from "./proposal-store";
import { keeperProposals } from "./proposals";
import {
  keeperSessionStartReceiptSchema,
  keeperSessionStartRequestSchema,
} from "./session-start-protocol";

interface Options {
  home: string;
  root: string;
  sessions: Pick<
    ReturnType<typeof createOwnedSessionService>,
    "start" | "list" | "read"
  > & {
    listIdentities?: (projectId: string) => Promise<SessionStartIdentityPage>;
  };
  /** Trusted current scope/capability preparation only. It reserves nothing and starts no provider turn. */
  prepare(projectId: string, input: SessionStartRequest): Promise<unknown>;
}

/** One human Start crosses proposal admission; only the existing owned journal dispatches. */
export function createKeeperSessionStartService(options: Options) {
  const workspace = resolveCheckout(options.root).workspace;
  const journal = createKeeperProposalStore(options.home);
  const conversations = createConversationStore(options.home);
  const active = new Set<Promise<unknown>>();
  let closed = false;
  const readable = (projectId: string) => {
    const project = createProjectStore(options.home)
      .read()
      .projects.find((item) => item.id === projectId);
    if (!project)
      throw new ConversationError(
        404,
        "This project is not in the hearth catalog.",
      );
    if (
      !project.workspaces.some(
        (item) => workspaceKey(item.root) === workspaceKey(workspace),
      )
    )
      throw new ConversationError(
        409,
        "This hearth does not serve the original session review's workspace.",
      );
  };
  const assertWorkspace = (value: string) => {
    if (workspaceKey(value) !== workspaceKey(workspace))
      throw new ConversationError(
        409,
        "The original session review belongs to a different workspace. Open its hearth to inspect it.",
      );
  };
  const sourceFor = (projectId: string, proposalId: string, hash: string) => {
    const source = keeperProposals(conversations.read(projectId)).find(
      (item) => item.id === proposalId,
    );
    if (
      !source ||
      source.sourceHash !== hash ||
      source.draft.action.kind !== "start-session"
    )
      throw new ConversationError(
        409,
        "The original session proposal source could not be verified. Read the current Keeper reply.",
      );
    if (source.draft.action.provider !== "claude")
      throw new ConversationError(
        409,
        "This proposal's provider has no attended session adapter here. No provider was selected automatically.",
      );
    return source;
  };
  const read = async (
    projectId: string,
    proposalId: string,
    requestId?: string,
  ): Promise<KeeperSessionStartReceipt> => {
    readable(projectId);
    const saved = await journal.readSessionStart(projectId, proposalId);
    readable(projectId);
    if (!saved)
      throw new ConversationError(
        404,
        "No original session Start is recorded for this proposal. Nothing was retried.",
      );
    assertWorkspace(saved.intent.workspace);
    if (
      requestId !== undefined &&
      saved.intent.original.start.requestId !== requestId
    )
      throw new ConversationError(
        409,
        "This proposal names a different original session Start.",
      );
    const session =
      options.sessions
        .list(projectId)
        .find(
          (item) => item.requestId === saved.intent.original.start.requestId,
        ) ?? null;
    if (
      session &&
      (session.requestHash !== saved.intent.startHash ||
        workspaceKey(session.workspace) !==
          workspaceKey(saved.intent.workspace))
    )
      throw new ConversationError(
        409,
        "The session reservation does not match the original reviewed Start. Its private input has been kept.",
      );
    const page = session
      ? await options.sessions.read(projectId, session.id, {
          requestId: session.requestId,
          limit: 1,
        })
      : null;
    // The protected original must still belong to this served project after
    // either awaited source returns, including an already captured page.
    readable(projectId);
    assertWorkspace(saved.intent.workspace);
    if (session && page?.request) {
      const input = saved.intent.original.start;
      const first = page.frames[0];
      const user = first?.event;
      const about = input.about ?? [];
      const expectedLaunch = {
        ...input.launch,
        context: {
          projectId,
          repository: input.repository,
          worktree: input.worktree,
          ...(input.beadId ? { beadId: input.beadId } : {}),
          about,
        },
      };
      if (
        session.smith !== input.smith ||
        session.repository !== input.repository ||
        session.worktree !== input.worktree ||
        session.beadId !== input.beadId ||
        session.mode !== input.launch.mode ||
        session.requestedModel !== input.launch.model ||
        session.requestedEffort !== (input.launch.effort ?? null) ||
        first?.seq !== 1 ||
        first.turnId !== input.requestId ||
        user?.kind !== "user" ||
        user.brief !== undefined ||
        user.text !== input.launch.prompt ||
        canonicalSessionInput(user.about) !== canonicalSessionInput(about) ||
        !user.session ||
        user.session.provider !== "claude" ||
        user.session.smith !== input.smith ||
        user.session.cwd !== input.worktree ||
        canonicalSessionInput(user.session.launch) !==
          canonicalSessionInput(expectedLaunch) ||
        page.request.requestId !== input.requestId ||
        page.request.hash !==
          createHash("sha256")
            .update(
              JSON.stringify({
                text: user.text,
                about: user.about,
                session: user.session,
              }),
            )
            .digest("hex")
      )
        throw new ConversationError(
          503,
          "The original session turn does not match its reviewed private input. Its saved data has been kept.",
        );
    }
    const receipt =
      session && page?.request
        ? {
            conversationId: session.id,
            revision: page.revision,
            turn: page.request,
          }
        : null;
    let retryAvailable = false;
    const input = saved.intent.original.start;
    const registryMatchesOriginal =
      session === null ||
      (session.projectId === projectId &&
        session.requestId === input.requestId &&
        session.requestHash === saved.intent.startHash &&
        session.provider === "claude" &&
        session.mode === input.launch.mode &&
        workspaceKey(session.workspace) ===
          workspaceKey(saved.intent.workspace) &&
        session.repository === input.repository &&
        session.worktree === input.worktree &&
        session.smith === input.smith &&
        session.beadId === input.beadId &&
        session.requestedModel === input.launch.model &&
        session.requestedEffort === (input.launch.effort ?? null));
    if (
      !receipt &&
      registryMatchesOriginal &&
      options.sessions.listIdentities
    ) {
      let identityPage: SessionStartIdentityPage | null = null;
      try {
        const raw = await options.sessions.listIdentities(projectId);
        const parsed = sessionStartIdentityPageSchema.safeParse(raw);
        if (parsed.success) identityPage = parsed.data;
      } catch {
        // A failed metadata read can never grant retry authority.
      }
      // The catalog/workspace may change while the second protected source is read.
      readable(projectId);
      assertWorkspace(saved.intent.workspace);
      if (identityPage) {
        const ownedStartHash = createHash("sha256")
          .update(canonicalOwnedSessionStart(saved.intent.original.start))
          .digest("hex");
        const identity = identityPage.identities.find(
          (item) => item.requestId === saved.intent.original.start.requestId,
        );
        retryAvailable =
          identityPage.version === 1 &&
          identityPage.scope.family === "owned-session-start" &&
          identityPage.scope.projectId === projectId &&
          workspaceKey(identityPage.scope.workspace) ===
            workspaceKey(saved.intent.workspace) &&
          ownedStartHash === saved.intent.startHash &&
          identity?.requestHash === ownedStartHash &&
          identity.provider === "claude" &&
          identity.mode === saved.intent.original.start.launch.mode &&
          identity.state === "not-sent";
      }
    }
    const record =
      receipt && session
        ? {
            ...saved.record,
            phase: "done" as const,
            pending: false,
            message:
              "The original session turn is confirmed. Open the session for its current outcome.",
            objects: [{ kind: "session" as const, id: session.id }],
          }
        : saved.record.phase === "done"
          ? {
              ...saved.record,
              phase: "unknown" as const,
              pending: false,
              message:
                "The original session turn could not be confirmed. Its private input has been kept.",
            }
          : saved.record;
    const checked = keeperSessionStartReceiptSchema.safeParse({
      projectId,
      proposalId,
      revision: saved.revision,
      record,
      original: saved.intent.original,
      startHash: saved.intent.startHash,
      retryAvailable,
      session,
      receipt,
    });
    if (!checked.success)
      throw new ConversationError(
        503,
        "The original session review could not be verified. Its private input has been kept.",
      );
    return checked.data;
  };
  const runStart = async (
    projectId: string,
    proposalId: string,
    raw: unknown,
    auditEventId: number,
  ) => {
    const request = keeperSessionStartRequestSchema.safeParse(raw);
    if (!request.success)
      throw new ConversationError(
        400,
        "Expected the complete strict original Keeper session Start.",
      );
    if (!Number.isSafeInteger(auditEventId) || auditEventId < 1)
      throw new ConversationError(
        503,
        "The confirmed operator audit is unavailable. No session review was admitted.",
      );
    if (closed)
      throw new ConversationError(
        503,
        "This hearth is closing. No session review was admitted.",
      );
    readable(projectId);
    const previous = await journal.readSessionStart(projectId, proposalId);
    if (previous) assertWorkspace(previous.intent.workspace);
    await journal.startSession(
      { projectId, proposalId, request: request.data, auditEventId },
      {
        async prepare() {
          sourceFor(projectId, proposalId, request.data.sourceHash);
          await options.prepare(projectId, structuredClone(request.data.start));
          if (closed)
            throw new ConversationError(
              503,
              "This hearth closed during session review. No Start was admitted.",
            );
          readable(projectId);
          return {
            proposal: sourceFor(projectId, proposalId, request.data.sourceHash),
            workspace,
          };
        },
        async execute(intent): Promise<KeeperProposalExecution> {
          if (closed)
            return {
              phase: "failed",
              message:
                "The hearth closed before the original Start could be confirmed. Its reviewed input has been kept.",
              objects: [],
            };
          assertWorkspace(intent.workspace);
          try {
            const started = sessionStartReceiptSchema.safeParse(
              await options.sessions.start(
                projectId,
                structuredClone(intent.original.start),
              ),
            );
            if (
              !started.success ||
              started.data.session.projectId !== projectId ||
              started.data.session.requestHash !== intent.startHash ||
              started.data.receipt.turn.requestId !==
                intent.original.start.requestId
            )
              return {
                phase: "unknown",
                message:
                  "The original session Start response could not be verified. Check the original request; it will not repeat automatically.",
                objects: [],
              };
            return {
              phase: "done",
              message:
                "The original session turn was accepted. Open the session for its current outcome.",
              objects: [{ kind: "session", id: started.data.session.id }],
            };
          } catch {
            return {
              phase: "unknown",
              message:
                "The original session Start is unconfirmed. Its private input has been kept; check its original request before explicitly retrying.",
              objects: [],
            };
          }
        },
      },
    );
    return read(projectId, proposalId, request.data.start.requestId);
  };
  return {
    read,
    start(
      projectId: string,
      proposalId: string,
      raw: unknown,
      auditEventId: number,
    ) {
      const work = runStart(projectId, proposalId, raw, auditEventId);
      active.add(work);
      void work.finally(() => active.delete(work)).catch(() => {});
      return work;
    },
    async close() {
      closed = true;
      await Promise.allSettled([...active]);
    },
  };
}
