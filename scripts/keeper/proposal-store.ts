import { dirname, join } from "node:path";
import type {
  KeeperProposal,
  KeeperProposalDraft,
  KeeperProposalExecution,
  KeeperProposalJournal,
  KeeperProposalReceipt,
  KeeperProposalRecord,
} from "../../types/keeper-proposal";
import { ConversationError } from "../conversations/error";
import {
  conversationDirectory,
  conversationLeaseFile,
} from "../conversations/paths";
import { hashText } from "../hash-text";
import {
  ensurePrivateHome,
  MAX_SESSION_TRANSCRIPT_BYTES,
  readSessionTranscript,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import {
  keeperProposalDraftSchema,
  keeperProposalExecutionSchema,
  keeperProposalJournalSchema,
  keeperProposalSchema,
} from "./proposal-protocol";

export function keeperProposalFile(home: string, projectId: string): string {
  return join(
    conversationDirectory(home, projectId),
    `keeper-${projectId}-proposals.json`,
  );
}
interface ReviewInput {
  projectId: string;
  proposal: KeeperProposal;
  requestId: string;
  expectedRevision: number;
  draft: KeeperProposalDraft;
  auditEventId: number;
}
const requestIdValid = (id: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    id,
  );
const uncertain =
  "The action's completion is unknown. Inspect the current objects; this approval will not be dispatched again.";

/** Private approval admission is durable before business I/O; reads never dispatch. */
export function createKeeperProposalStore(
  home: string,
  now: () => Date = () => new Date(),
) {
  const inflight = new Set<string>();
  const lease = (projectId: string) =>
    join(
      dirname(conversationLeaseFile(home, projectId)),
      `${projectId}-proposals.db`,
    );
  const raw = (projectId: string): KeeperProposalJournal => {
    const found = readSessionTranscript(
      home,
      keeperProposalFile(home, projectId),
    );
    if (found.problem)
      throw new ConversationError(
        503,
        "The private proposal journal could not be read. Its saved data has been kept.",
      );
    if (found.text === null)
      return { version: 1, projectId, revision: 0, records: [] };
    let value: unknown;
    try {
      value = JSON.parse(found.text);
    } catch {
      throw new ConversationError(
        503,
        "The private proposal journal is invalid. Its saved data has been kept.",
      );
    }
    const parsed = keeperProposalJournalSchema.safeParse(value);
    if (!parsed.success || parsed.data.projectId !== projectId)
      throw new ConversationError(
        503,
        "The private proposal journal could not be verified. Its saved data has been kept.",
      );
    return parsed.data;
  };
  const save = (state: KeeperProposalJournal) => {
    const content = JSON.stringify(state);
    if (
      !keeperProposalJournalSchema.safeParse(state).success ||
      Buffer.byteLength(content) > MAX_SESSION_TRANSCRIPT_BYTES
    )
      throw new ConversationError(
        503,
        "The private proposal journal is full or invalid. Its saved data has been kept.",
      );
    writeOwnerOnly(keeperProposalFile(home, state.projectId), content);
  };
  const read = async (projectId: string): Promise<KeeperProposalJournal> => {
    const state = raw(projectId);
    if (
      inflight.has(projectId) ||
      !state.records.some((record) => record.pending)
    )
      return state;
    const observed = await withQueueLock(
      lease(projectId),
      async () => raw(projectId),
      { waitMs: 25 },
    );
    if (!observed.ok) return state;
    return {
      ...observed.value,
      records: observed.value.records.map((record) =>
        record.pending
          ? { ...record, phase: "unknown", pending: false, message: uncertain }
          : record,
      ),
    };
  };
  const change = async (
    input: ReviewInput,
    operation: "approve" | "dismiss",
    execute?: () => Promise<KeeperProposalExecution>,
  ): Promise<KeeperProposalReceipt> => {
    const source = keeperProposalSchema.safeParse(input.proposal),
      draft = keeperProposalDraftSchema.safeParse(
        operation === "dismiss" ? input.proposal.draft : input.draft,
      );
    if (!source.success || source.data.projectId !== input.projectId)
      throw new ConversationError(
        400,
        "Expected this project's verified source proposal.",
      );
    if (
      !draft.success ||
      !requestIdValid(input.requestId) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      throw new ConversationError(
        400,
        "Expected a bounded reviewed proposal and request identity.",
      );
    if (!Number.isSafeInteger(input.auditEventId) || input.auditEventId < 1)
      throw new ConversationError(
        503,
        "An approval needs a confirmed operator audit row before admission.",
      );
    const requestHash = hashText(
      JSON.stringify({
        operation,
        sourceHash: source.data.sourceHash,
        draft: draft.data,
      }),
    );
    const existing = (
      state: KeeperProposalJournal,
    ): KeeperProposalReceipt | null => {
      const byRequest = state.records.find(
        (record) => record.requestId === input.requestId,
      );
      if (byRequest) {
        if (
          byRequest.id !== source.data.id ||
          byRequest.requestHash !== requestHash ||
          byRequest.sourceHash !== source.data.sourceHash
        )
          throw new ConversationError(
            409,
            "This request already names different reviewed content.",
          );
        return {
          projectId: input.projectId,
          revision: state.revision,
          record: byRequest,
        };
      }
      if (state.records.some((record) => record.id === source.data.id))
        throw new ConversationError(
          409,
          "This proposal already has a recorded review. Inspect its original outcome.",
        );
      return null;
    };
    const previous = existing(await read(input.projectId));
    if (previous) return previous;
    ensurePrivateHome(home);
    inflight.add(input.projectId);
    try {
      const locked = await withQueueLock(
        lease(input.projectId),
        async () => {
          const state = raw(input.projectId),
            prior = existing(state);
          if (prior) return prior;
          if (state.revision !== input.expectedRevision)
            throw new ConversationError(
              409,
              "Proposal review changed. Read it again before approving.",
            );
          const record: KeeperProposalRecord = {
            ...source.data,
            draft: draft.data,
            requestId: input.requestId,
            requestHash,
            operation,
            auditEventId: input.auditEventId,
            phase: operation === "dismiss" ? "dismissed" : "approved",
            pending: operation === "approve",
            updatedAt: now().toISOString(),
            message:
              operation === "dismiss"
                ? "Dismissed. Nothing was executed."
                : "Approval recorded. Waiting for the action's confirmed outcome.",
            objects: [],
          };
          state.records.push(record);
          state.revision++;
          save(state);
          if (operation === "approve") {
            let outcome: KeeperProposalExecution;
            try {
              const parsed = keeperProposalExecutionSchema.safeParse(
                await execute?.(),
              );
              outcome = parsed.success
                ? parsed.data
                : { phase: "unknown", message: uncertain, objects: [] };
            } catch {
              outcome = { phase: "unknown", message: uncertain, objects: [] };
            }
            Object.assign(record, outcome, {
              pending: false,
              updatedAt: now().toISOString(),
            });
            state.revision++;
            save(state);
          }
          return {
            projectId: input.projectId,
            revision: state.revision,
            record,
          };
        },
        { waitMs: 300 },
      );
      if (!locked.ok)
        throw new ConversationError(
          409,
          "Proposal review is busy. Read the original outcome before retrying.",
        );
      return locked.value;
    } finally {
      inflight.delete(input.projectId);
    }
  };
  return {
    read,
    approve: (
      input: ReviewInput,
      execute: () => Promise<KeeperProposalExecution>,
    ) => change(input, "approve", execute),
    dismiss: (input: ReviewInput) => change(input, "dismiss"),
  };
}
