import type {
  KeeperProposal,
  KeeperProposalExecution,
} from "../../types/keeper-proposal";
import type {
  KeeperShiftStartIntent,
  KeeperShiftStartReceipt,
  KeeperShiftStartRequest,
} from "../../types/keeper-shift-start";
import type { ProjectShiftReceipt } from "../../types/project-shifts";
import {
  ConversationError,
  createConversationStore,
} from "../conversations/store";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { createProjectStore } from "../projects/store";
import { projectShiftReceiptSchema } from "../shifts/protocol";
import type { createProjectShiftService } from "../shifts/service";
import { canonicalProjectShiftStart } from "../shifts/start-input";
import { createKeeperProposalStore } from "./proposal-store";
import { keeperProposals } from "./proposals";
import {
  keeperShiftStartReceiptSchema,
  keeperShiftStartRequestSchema,
} from "./shift-start-protocol";

interface Options {
  home: string;
  root: string;
  /** The same canonical owner used by project Shift routes; this service never creates another runtime. */
  shifts: Pick<ReturnType<typeof createProjectShiftService>, "read" | "start">;
}

/** One explicit human review binds the saved Keeper source and editable full request to the existing Shift owner. */
export function createKeeperShiftStartService(options: Options) {
  const workspace = resolveCheckout(options.root).workspace,
    journal = createKeeperProposalStore(options.home),
    conversations = createConversationStore(options.home),
    active = new Set<Promise<unknown>>();
  let closed = false;

  const readable = (projectId: string, allowArchived: boolean) => {
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
        "This hearth does not serve the original Keeper Shift review's workspace.",
      );
    if (!allowArchived && project.archived)
      throw new ConversationError(
        409,
        "This project is archived. Existing Shift originals remain inspectable, but new Starts are refused.",
      );
  };
  const assertWorkspace = (value: string) => {
    if (workspaceKey(value) !== workspaceKey(workspace))
      throw new ConversationError(
        409,
        "The original Keeper Shift review belongs to a different workspace.",
      );
  };
  const sourceFor = (
    projectId: string,
    proposalId: string,
    sourceHash: string,
  ): KeeperProposal => {
    const source = keeperProposals(conversations.read(projectId)).find(
      (item) => item.id === proposalId,
    );
    if (
      !source ||
      source.projectId !== projectId ||
      source.sourceHash !== sourceHash ||
      source.draft.action.kind !== "start-shift"
    )
      throw new ConversationError(
        409,
        "The original Keeper Shift proposal source could not be verified. Read the current Keeper reply.",
      );
    return source;
  };
  const correlated = (
    intent: KeeperShiftStartIntent,
    raw: unknown,
  ): ProjectShiftReceipt | null => {
    const parsed = projectShiftReceiptSchema.safeParse(raw);
    if (!parsed.success) return null;
    const shift = parsed.data;
    if (
      shift.intent.projectId !== intent.projectId ||
      workspaceKey(shift.intent.workspace) !== workspaceKey(intent.workspace) ||
      shift.intent.requestHash !== intent.startHash ||
      canonicalProjectShiftStart(
        intent.projectId,
        intent.workspace,
        shift.intent.request,
      ) !==
        canonicalProjectShiftStart(
          intent.projectId,
          intent.workspace,
          intent.original.start,
        )
    )
      return null;
    return shift;
  };
  const read = async (
    projectId: string,
    proposalId: string,
    requestId?: string,
  ): Promise<KeeperShiftStartReceipt> => {
    readable(projectId, true);
    const saved = await journal.readShiftStart(projectId, proposalId);
    readable(projectId, true);
    if (!saved)
      throw new ConversationError(
        404,
        "No original Keeper Shift Start is recorded for this proposal. Nothing was retried.",
      );
    assertWorkspace(saved.intent.workspace);
    if (
      requestId !== undefined &&
      saved.intent.original.start.requestId !== requestId
    )
      throw new ConversationError(
        409,
        "This proposal names a different original Keeper Shift Start.",
      );
    let shift: ProjectShiftReceipt | null = null;
    try {
      const observed = options.shifts.read(
        projectId,
        saved.intent.original.start.requestId,
      );
      shift = correlated(saved.intent, observed);
      if (!shift)
        throw new ConversationError(
          503,
          "The canonical Shift receipt does not match the original Keeper review. Its saved input has been kept.",
        );
    } catch (error) {
      if ((error as { status?: unknown } | null)?.status !== 404) throw error;
    }
    readable(projectId, true);
    const record =
      shift === null && saved.record.phase === "done"
        ? {
            ...saved.record,
            phase: "unknown" as const,
            pending: false,
            message:
              "The canonical Shift original could not be confirmed. Its saved request has been kept and will not repeat automatically.",
          }
        : saved.record;
    const result = keeperShiftStartReceiptSchema.safeParse({
      projectId,
      proposalId,
      revision: saved.revision,
      record,
      workspace: saved.intent.workspace,
      original: saved.intent.original,
      startHash: saved.intent.startHash,
      shift,
    });
    if (!result.success)
      throw new ConversationError(
        503,
        "The original Keeper Shift review could not be verified. Its private input has been kept.",
      );
    return result.data;
  };
  const runStart = async (
    projectId: string,
    proposalId: string,
    raw: unknown,
    auditEventId: number,
  ) => {
    const request = keeperShiftStartRequestSchema.safeParse(raw);
    if (!request.success)
      throw new ConversationError(
        400,
        "Expected the complete strict original Keeper Shift Start.",
      );
    if (!Number.isSafeInteger(auditEventId) || auditEventId < 1)
      throw new ConversationError(
        503,
        "The confirmed operator audit is unavailable. No Keeper Shift review was admitted.",
      );
    if (closed)
      throw new ConversationError(
        503,
        "This hearth is closing. No Keeper Shift review was admitted.",
      );
    readable(projectId, true);
    const previous = await journal.readShiftStart(projectId, proposalId);
    readable(projectId, true);
    if (previous) assertWorkspace(previous.intent.workspace);
    else readable(projectId, false);

    await journal.startShift(
      { projectId, proposalId, request: request.data, auditEventId },
      {
        async prepare() {
          if (closed)
            throw new ConversationError(
              503,
              "This hearth closed during Keeper Shift review. No Start was admitted.",
            );
          readable(projectId, false);
          const proposal = sourceFor(
            projectId,
            proposalId,
            request.data.sourceHash,
          );
          readable(projectId, false);
          return { proposal, workspace };
        },
        async execute(intent): Promise<KeeperProposalExecution> {
          if (closed)
            return {
              phase: "failed",
              message:
                "The hearth closed before the original Shift Start could be confirmed. Its reviewed input has been kept.",
              objects: [],
            };
          try {
            readable(projectId, false);
            sourceFor(projectId, proposalId, intent.original.sourceHash);
            readable(projectId, false);
            const rawShift = await options.shifts.start(
              projectId,
              structuredClone(intent.original.start),
            );
            readable(projectId, true);
            const shift = correlated(intent, rawShift);
            if (!shift)
              return {
                phase: "unknown",
                message:
                  "The canonical Shift Start response could not be verified. Inspect the original request; it will not be sent again automatically.",
                objects: [],
              };
            return {
              phase: "done",
              message:
                "The original Keeper Shift Start was recorded by the canonical Shift service. Read its current outcome below.",
              objects: [],
            };
          } catch {
            return {
              phase: "unknown",
              message:
                "The original Keeper Shift Start is unconfirmed. Its private input has been kept; it will not repeat automatically.",
              objects: [],
            };
          }
        },
      },
    );
    readable(projectId, true);
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
