import type { ConversationObject } from "../../types/conversation";
import type {
  KeeperProposal,
  KeeperProposalActivity,
  KeeperProposalDraft,
  KeeperProposalExecution,
  KeeperProposalPage,
  KeeperProposalRecord,
} from "../../types/keeper-proposal";
import { loadConfig } from "../config/load";
import {
  ConversationError,
  createConversationStore,
} from "../conversations/store";
import { BEAD_TEXT_LIMITS } from "../hearth/routes/beads";
import type { ProjectSnapshot } from "../hearth/routes/project-summaries";
import { isBeadId } from "../hearth/tracker-write";
import { validateOperatorEnvelope } from "../hearth/validate";
import { selectProjectBeads, workspaceKey } from "../projects/scope";
import { createProjectStore } from "../projects/store";
import { checkSmith } from "../scheduler/queue";
import { operatorMoves } from "../scheduler/queue-table";
import type { KeeperOperatorCall, KeeperOperatorPost } from "./operator-post";
import {
  keeperProposalApprovalSchema,
  keeperProposalDismissalSchema,
  keeperProposalDraftSchema,
} from "./proposal-protocol";
import { createKeeperProposalStore } from "./proposal-store";
import { keeperProposals } from "./proposals";
import type { createKeeperSessionStartService } from "./session-start-service";

interface Options {
  home: string;
  root: string;
  configHome?: string | undefined;
  load(): Promise<ProjectSnapshot>;
  post?: KeeperOperatorPost | undefined;
  sessionStarts?:
    | Pick<ReturnType<typeof createKeeperSessionStartService>, "read">
    | undefined;
  activity?:
    | ((id: number, target: string) => KeeperProposalActivity | null)
    | undefined;
}
const sourceOf = (record: KeeperProposalRecord): KeeperProposal => ({
  id: record.id,
  projectId: record.projectId,
  sourceRequestId: record.sourceRequestId,
  sourceHash: record.sourceHash,
  createdAt: record.createdAt,
  draft: record.draft,
});
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
class DispatchProblem extends Error {
  constructor(
    readonly phase: "failed" | "unknown",
    message: string,
  ) {
    super(message);
  }
}

/** Explicit owner review is the only path from untrusted intent to a closed operator call. */
export function createKeeperProposalService(options: Options) {
  const journal = createKeeperProposalStore(options.home),
    conversations = createConversationStore(options.home);
  let closed = false;
  const active = new Set<Promise<unknown>>();
  const controllers = new Set<AbortController>();
  const snapshotFor = async (projectId: string) => {
    const snapshot = await options.load(),
      catalog = createProjectStore(options.home).read();
    if (catalog.revision !== snapshot.catalog.revision)
      throw new ConversationError(
        409,
        "Project scope changed during the read. Refresh before approving.",
      );
    const project = catalog.projects.find((item) => item.id === projectId);
    if (!project)
      throw new ConversationError(
        404,
        "This project is not in the hearth catalog.",
      );
    if (
      !project.workspaces.some(
        (item) =>
          workspaceKey(item.root) === workspaceKey(snapshot.source.workspace),
      )
    )
      throw new ConversationError(
        409,
        "This hearth does not serve this project's scope.",
      );
    return {
      snapshot,
      project,
      members: new Set(
        selectProjectBeads(
          project,
          snapshot.source.workspace,
          snapshot.source.issues ?? [],
        ).map((item) => item.id),
      ),
    };
  };
  type Scope = Awaited<ReturnType<typeof snapshotFor>>;
  const member = (scope: Scope, id: string) => {
    if (scope.snapshot.source.issues === null)
      throw new ConversationError(
        409,
        "The project's current scope is unavailable. Refresh the tracker read before approving.",
      );
    if (!scope.members.has(id))
      throw new ConversationError(
        409,
        "An object is outside this project's verified scope.",
      );
  };
  const queueMove = (
    scope: Scope,
    id: string,
    move: "approve" | "propose" | "pause" | "resume" | "reassign",
  ) => {
    member(scope, id);
    if (scope.snapshot.source.queue === null)
      throw new ConversationError(409, "The scoped queue is unavailable.");
    const entry = scope.snapshot.source.queue.find(
      (item) => item.beadId === id,
    );
    if (move === "propose" && !entry) return;
    if (!entry || !operatorMoves(entry).includes(move))
      throw new ConversationError(
        409,
        "The current queue state does not allow this reviewed move.",
      );
  };
  const smith = (name: string) => {
    try {
      const { config } = loadConfig({
        harnessRoot: options.root,
        env: {},
        ...(options.configHome !== undefined
          ? { home: options.configHome }
          : {}),
      });
      if (checkSmith(config, name).ok) return;
    } catch {
      /* Availability is not authority to guess a smith. */
    }
    throw new ConversationError(
      409,
      "The reviewed smith is unavailable in this hearth's current configuration.",
    );
  };
  const validateDraft = async (
    projectId: string,
    draft: KeeperProposalDraft,
    knownScope?: Scope,
  ) => {
    const scope = knownScope ?? (await snapshotFor(projectId)),
      action = draft.action;
    switch (action.kind) {
      case "approve-beads":
        for (const id of action.beadIds) queueMove(scope, id, "approve");
        break;
      case "record-decision":
        member(scope, action.beadId);
        break;
      case "create-beads":
        for (const bead of action.beads) {
          member(scope, bead.parentId);
          if (
            bead.description.length > BEAD_TEXT_LIMITS.description ||
            bead.description.trim() === "-"
          )
            throw new ConversationError(
              409,
              `Edit the bead description before approval: at most ${BEAD_TEXT_LIMITS.description} characters, and not the stdin placeholder '-'.`,
            );
        }
        break;
      case "manage-bead":
        queueMove(scope, action.beadId, action.operation.kind);
        if (action.operation.kind === "reassign") smith(action.operation.smith);
        break;
      case "start-session":
        member(scope, action.beadId);
        if (
          !scope.project.workspaces.some(
            (item) =>
              workspaceKey(item.root) ===
                workspaceKey(scope.snapshot.source.workspace) &&
              item.repositories.some(
                (repo) =>
                  workspaceKey(repo) === workspaceKey(action.repository),
              ),
          )
        )
          throw new ConversationError(
            409,
            "The reviewed repository is outside this project's scope.",
          );
        if (options.sessionStarts && action.provider === "claude") return;
        throw new ConversationError(
          409,
          "The session review composer is not available yet. This card cannot start a session.",
        );
      case "start-shift":
        throw new ConversationError(
          409,
          "The attended project shift review is not available yet. This card cannot start a shift.",
        );
      case "send-to-council":
        member(scope, action.beadId);
        throw new ConversationError(
          409,
          "The project council review composer is not available yet. This card cannot convene a review.",
        );
    }
    if (!options.post)
      throw new ConversationError(
        409,
        "This hearth's mapped operator dispatch is unavailable.",
      );
  };
  const validateCall = async (projectId: string, call: KeeperOperatorCall) => {
    const scope = await snapshotFor(projectId);
    if (call.kind === "bead.create") member(scope, call.parentId);
    else if (call.kind === "bead.comment") member(scope, call.id);
    else if (call.kind === "queue.reassign") {
      queueMove(scope, call.id, "reassign");
      smith(call.smith);
    } else queueMove(scope, call.id, call.action);
  };
  const execute = async (
    projectId: string,
    draft: KeeperProposalDraft,
    signal: AbortSignal,
  ): Promise<KeeperProposalExecution> => {
    const objects: ConversationObject[] = [];
    const affected = (id: string) => {
      if (!objects.some((item) => item.id === id))
        objects.push({ kind: "bead", id });
    };
    let confirmed = 0,
      missingTransition = false;
    const invoke = async (
      call: KeeperOperatorCall,
    ): Promise<Record<string, unknown>> => {
      if (closed || signal.aborted)
        throw new DispatchProblem(
          "failed",
          "The hearth closed before the remaining work was attempted.",
        );
      await validateCall(projectId, call);
      if (closed || signal.aborted)
        throw new DispatchProblem(
          "failed",
          "The hearth closed before the remaining work was attempted.",
        );
      if (call.kind !== "bead.create") affected(call.id);
      let status: number, raw: unknown;
      try {
        const answer = await options.post?.(call, signal);
        if (!answer) throw new Error("No dispatcher");
        status = answer.status;
        raw = JSON.parse(answer.body);
      } catch {
        throw new DispatchProblem(
          "unknown",
          "A mapped operator response was lost or invalid. Inspect the linked objects before doing anything else.",
        );
      }
      const envelope = validateOperatorEnvelope(raw);
      if (!envelope.ok || !envelope.value.ok || !isRecord(envelope.value.data))
        throw new DispatchProblem(
          [400, 401, 403, 404, 405, 409, 413, 422].includes(status)
            ? "failed"
            : "unknown",
          "The mapped action did not confirm the reviewed change. No further requests were sent.",
        );
      const data = envelope.value.data;
      if (
        status < 200 ||
        status >= 300 ||
        typeof data["recorded"] !== "boolean"
      )
        throw new DispatchProblem(
          "unknown",
          "The mapped action did not return a verified outcome.",
        );
      if (call.kind === "bead.create") {
        if (data["action"] !== "create" || !isBeadId(data["id"]))
          throw new DispatchProblem(
            "unknown",
            "The created bead identity could not be verified.",
          );
        affected(data["id"]);
      } else if (
        data["id"] !== call.id ||
        (call.kind === "bead.comment"
          ? data["action"] !== "comment" || !isRecord(data["comment"])
          : call.kind === "queue.reassign"
            ? data["smith"] !== call.smith
            : data["action"] !== call.action || typeof data["to"] !== "string")
      )
        throw new DispatchProblem(
          "unknown",
          "The mapped response did not match the reviewed object and action.",
        );
      confirmed++;
      missingTransition ||= data["recorded"] === false;
      return data;
    };
    try {
      switch (draft.action.kind) {
        case "approve-beads":
          for (const id of draft.action.beadIds)
            await invoke({ kind: "queue.move", id, action: "approve" });
          break;
        case "record-decision":
          await invoke({
            kind: "bead.comment",
            id: draft.action.beadId,
            text: draft.action.decision.startsWith("design:")
              ? draft.action.decision
              : `design: ${draft.action.decision}`,
          });
          break;
        case "create-beads":
          for (const bead of draft.action.beads) {
            const result = await invoke({ kind: "bead.create", ...bead });
            const id = result["id"];
            if (typeof id !== "string")
              throw new DispatchProblem(
                "unknown",
                "The created bead identity could not be verified.",
              );
            await invoke({ kind: "queue.move", id, action: "propose" });
          }
          break;
        case "manage-bead":
          if (draft.action.operation.kind === "reassign")
            await invoke({
              kind: "queue.reassign",
              id: draft.action.beadId,
              smith: draft.action.operation.smith,
            });
          else
            await invoke({
              kind: "queue.move",
              id: draft.action.beadId,
              action: draft.action.operation.kind,
            });
          break;
        default:
          throw new DispatchProblem(
            "failed",
            "This review destination is not available. Nothing was started.",
          );
      }
      return {
        phase: "done",
        message: `The reviewed changes were confirmed.${missingTransition ? " A transition event could not be recorded; the approval audit remains available." : ""}`,
        objects,
      };
    } catch (error) {
      return {
        phase:
          error instanceof DispatchProblem
            ? error.phase
            : error instanceof ConversationError
              ? "failed"
              : "unknown",
        message: `${error instanceof DispatchProblem || error instanceof ConversationError ? error.message : "The action did not produce a confirmed outcome."}${confirmed ? " Some earlier steps were confirmed; inspect the linked objects." : ""} This approval will not automatically repeat.`,
        objects,
      };
    }
  };
  const sourceFor = (projectId: string, id: string, hash: string) => {
    const source = keeperProposals(conversations.read(projectId)).find(
      (item) => item.id === id,
    );
    if (!source || source.sourceHash !== hash)
      throw new ConversationError(
        409,
        "The proposal source could not be verified. Read the current Keeper reply.",
      );
    return source;
  };
  const read = async (
    projectId: string,
    query: { requestId?: string } = {},
  ): Promise<KeeperProposalPage> => {
    const state = conversations.read(projectId),
      current = keeperProposals(state),
      saved = await journal.read(projectId),
      scope = await snapshotFor(projectId);
    const proposals: KeeperProposalPage["proposals"] = [];
    for (const proposal of current.slice(-40)) {
      let record =
        saved.records.find((item) => item.id === proposal.id) ?? null;
      if (
        record?.operation === "approve" &&
        record.draft.action.kind === "start-session" &&
        options.sessionStarts
      )
        try {
          record = (
            await options.sessionStarts.read(
              projectId,
              proposal.id,
              record.requestId,
            )
          ).record;
        } catch {
          /* A failed private observation does not discard a recorded approval. */
        }
      let available = false,
        reason: string | null = null;
      if (record) reason = "This card already has a recorded review.";
      else
        try {
          await validateDraft(projectId, proposal.draft, scope);
          available = true;
        } catch (error) {
          reason =
            error instanceof ConversationError
              ? error.message
              : "Current action availability could not be verified.";
        }
      let activity: KeeperProposalActivity | null = null;
      if (record)
        try {
          activity = options.activity?.(record.auditEventId, record.id) ?? null;
        } catch {
          /* An unavailable audit read does not erase the private result. */
        }
      const destinationAvailable =
        (proposal.draft.action.kind === "start-session" &&
          proposal.draft.action.provider === "claude" &&
          !!options.sessionStarts) ||
        (!!options.post &&
          !["start-session", "start-shift", "send-to-council"].includes(
            proposal.draft.action.kind,
          ));
      proposals.push({
        proposal,
        record,
        available,
        destinationAvailable,
        reason,
        activity,
      });
    }
    const page: KeeperProposalPage = {
      projectId,
      revision: saved.revision,
      conversationRevision: state.revision,
      request:
        saved.records.find((item) => item.requestId === query.requestId) ??
        null,
      asOf: scope.snapshot.source.asOf,
      proposals,
      complete: current.length <= 40,
      problems:
        current.length > 40
          ? ["Only the latest forty proposals are shown in this read."]
          : [],
    };
    while (
      Buffer.byteLength(JSON.stringify(page)) > 128_000 &&
      page.proposals.length
    ) {
      page.proposals.shift();
      page.complete = false;
    }
    if (page.proposals.length < Math.min(current.length, 40))
      page.problems.push(
        "Proposal details are bounded by bytes; older cards were omitted from this read.",
      );
    return page;
  };
  const runReview = async (
    projectId: string,
    body: unknown,
    auditEventId: number,
    dismiss = false,
  ) => {
    const parsed = dismiss
      ? keeperProposalDismissalSchema.safeParse(body)
      : keeperProposalApprovalSchema.safeParse(body);
    if (!parsed.success)
      throw new ConversationError(
        400,
        "Expected a strict reviewed proposal request.",
      );
    const input = parsed.data,
      saved = await journal.read(projectId),
      existing = saved.records.find(
        (item) => item.id === input.id || item.requestId === input.requestId,
      );
    let proposal: KeeperProposal;
    if (existing) {
      if (existing.id !== input.id || existing.sourceHash !== input.sourceHash)
        throw new ConversationError(
          409,
          "The request names a different proposal source.",
        );
      proposal = sourceOf(existing);
    } else proposal = sourceFor(projectId, input.id, input.sourceHash);
    const reviewed = keeperProposalDraftSchema.safeParse(
      "draft" in input ? input.draft : proposal.draft,
    );
    if (!reviewed.success)
      throw new ConversationError(400, "Expected a bounded reviewed proposal.");
    const draft = reviewed.data;
    if (!dismiss && draft.action.kind === "start-session")
      throw new ConversationError(
        409,
        "Review the complete session in the composer, then press Start. The small proposal approval cannot authorize a provider launch.",
      );
    if (closed)
      throw new ConversationError(
        503,
        "The hearth is closing. No new review was admitted.",
      );
    if (!dismiss && !existing) await validateDraft(projectId, draft);
    if (closed)
      throw new ConversationError(
        503,
        "The hearth is closing. No new review was admitted.",
      );
    const request = {
      projectId,
      proposal,
      requestId: input.requestId,
      expectedRevision: input.expectedRevision,
      draft,
      auditEventId,
    };
    if (dismiss) return journal.dismiss(request);
    return journal.approve(request, async () => {
      const controller = new AbortController();
      controllers.add(controller);
      try {
        return await execute(projectId, draft, controller.signal);
      } finally {
        controllers.delete(controller);
      }
    });
  };
  const review = (
    projectId: string,
    body: unknown,
    auditEventId: number,
    dismiss = false,
  ) => {
    const work = runReview(projectId, body, auditEventId, dismiss);
    active.add(work);
    void work.finally(() => active.delete(work)).catch(() => {});
    return work;
  };
  return {
    read,
    approve: (projectId: string, body: unknown, auditEventId: number) =>
      review(projectId, body, auditEventId),
    dismiss: (projectId: string, body: unknown, auditEventId: number) =>
      review(projectId, body, auditEventId, true),
    async close() {
      closed = true;
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...active]);
    },
  };
}
