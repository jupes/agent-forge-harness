import type { ActionOutcome } from "../../../docs/js/action-outcome";
import {
  keeperProposalApprovalSchema,
  keeperProposalPageSchema,
  keeperProposalReceiptSchema,
} from "../../../scripts/keeper/proposal-protocol";
import type {
  KeeperProposalDraft,
  KeeperProposalPage,
  KeeperProposalRecord,
  KeeperProposalView,
} from "../../../types/keeper-proposal";

type ReviewBody = {
  id: string;
  sourceHash: string;
  requestId: string;
  expectedRevision: number;
  draft?: KeeperProposalDraft;
};
export interface ProposalState {
  page: KeeperProposalPage | null;
  loading: boolean;
  error: string | null;
  notice: string;
  drafts: Map<string, KeeperProposalDraft>;
  receipts: Map<string, KeeperProposalRecord>;
  fence: number;
  pending: {
    operation: "approve" | "dismiss";
    body: ReviewBody;
    uncertain: boolean;
  } | null;
  posting: boolean;
}
interface Deps {
  read(projectId: string, query: { requestId?: string }): Promise<unknown>;
  post(
    projectId: string,
    operation: "approve" | "dismiss",
    body: ReviewBody,
  ): Promise<ActionOutcome>;
  requestId(): string;
  canWrite(): boolean;
}
/** Shared by full Keeper and drawer. Only an explicit owner gesture can send a write. */
export function createKeeperProposalsClient(deps: Deps) {
  const entries = new Map<string, ProposalState>();
  const listeners = new Set<() => void>();
  const reads = new Map<string, { promise: Promise<void>; again: boolean }>();
  let disposed = false;
  const get = (id: string): ProposalState => {
    let entry = entries.get(id);
    if (!entry) {
      entry = {
        page: null,
        loading: false,
        error: null,
        notice: "",
        drafts: new Map(),
        receipts: new Map(),
        fence: 0,
        pending: null,
        posting: false,
      };
      entries.set(id, entry);
    }
    return entry;
  };
  const tell = () => {
    if (!disposed) for (const listener of [...listeners]) listener();
  };
  const matchesRequest = (
    pending: ProposalState["pending"],
    record: KeeperProposalRecord,
  ) => {
    return (
      pending &&
      record.id === pending.body.id &&
      record.sourceHash === pending.body.sourceHash &&
      record.requestId === pending.body.requestId &&
      record.operation === pending.operation &&
      (pending.operation === "dismiss" ||
        JSON.stringify(record.draft) === JSON.stringify(pending.body.draft))
    );
  };
  const matches = (entry: ProposalState, record: KeeperProposalRecord) =>
    matchesRequest(entry.pending, record);
  const confirm = (entry: ProposalState, record: KeeperProposalRecord) => {
    const previous = entry.receipts.get(record.id);
    if (previous && !previous.pending) record = previous;
    entry.receipts.set(record.id, record);
    if (matches(entry, record)) {
      entry.notice = record.message;
      if (!record.pending) entry.pending = null;
    }
  };
  const refresh = (id: string, follow = false): Promise<void> => {
    if (disposed) return Promise.resolve();
    const running = reads.get(id);
    if (running) {
      running.again ||= follow;
      return running.promise;
    }
    const entry = get(id),
      requestId = entry.pending?.body.requestId;
    const read = { promise: Promise.resolve(), again: false };
    reads.set(id, read);
    entry.loading = true;
    entry.error = null;
    tell();
    read.promise = (async () => {
      try {
        const result = keeperProposalPageSchema.safeParse(
          await deps.read(id, requestId ? { requestId } : {}),
        );
        if (disposed) return;
        if (
          !result.success ||
          result.data.projectId !== id ||
          (result.data.request && result.data.request.requestId !== requestId)
        )
          throw new Error("Invalid proposal read");
        const page = result.data;
        if (
          page.revision < entry.fence ||
          (entry.page &&
            (page.revision < entry.page.revision ||
              page.conversationRevision < entry.page.conversationRevision))
        )
          throw new Error("Earlier projection");
        if (
          page.request &&
          entry.pending?.body.requestId === page.request.requestId &&
          !matches(entry, page.request)
        )
          throw new Error("Different original request");
        entry.page = page;
        for (const card of page.proposals)
          if (card.record) confirm(entry, card.record);
        if (page.request) {
          confirm(entry, page.request);
        }
      } catch {
        if (!disposed)
          entry.error =
            "The action-card read could not be verified. Saved drafts and confirmed results have been kept.";
      } finally {
        reads.delete(id);
        entry.loading = false;
        tell();
        if (!disposed && read.again) void refresh(id);
      }
    })();
    return read.promise;
  };
  const send = async (id: string) => {
    const entry = get(id),
      pending = entry.pending;
    if (disposed || !pending || entry.posting || !deps.canWrite()) return;
    entry.posting = true;
    tell();
    try {
      const result = await deps.post(id, pending.operation, pending.body);
      if (disposed) return;
      if (result.state === "done") {
        const receipt = keeperProposalReceiptSchema.safeParse(result.data);
        if (
          !receipt.success ||
          receipt.data.projectId !== id ||
          !matchesRequest(pending, receipt.data.record)
        ) {
          pending.uncertain = true;
          entry.notice =
            "The approval result could not be verified. Check the original request before retrying.";
        } else {
          entry.fence = Math.max(entry.fence, receipt.data.revision);
          confirm(entry, receipt.data.record);
          entry.notice =
            entry.receipts.get(receipt.data.record.id)?.message ??
            receipt.data.record.message;
        }
      } else {
        const confirmed = entry.receipts.get(pending.body.id);
        entry.notice =
          confirmed?.requestId === pending.body.requestId
            ? confirmed.message
            : result.message;
        if (result.state === "unknown") pending.uncertain = true;
        else if (!pending.uncertain) entry.pending = null;
      }
    } catch {
      pending.uncertain = true;
      entry.notice =
        "The review response was lost. Check the original request before retrying.";
    } finally {
      entry.posting = false;
      tell();
      if (!disposed) await refresh(id, true);
    }
  };
  return {
    get,
    refresh,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    draft(id: string, cardId: string, draft: KeeperProposalDraft) {
      get(id).drafts.set(cardId, draft);
      tell();
    },
    record(id: string, card: KeeperProposalView) {
      return get(id).receipts.get(card.proposal.id) ?? card.record;
    },
    async review(id: string, cardId: string, operation: "approve" | "dismiss") {
      const entry = get(id),
        card = entry.page?.proposals.find(
          (item) => item.proposal.id === cardId,
        );
      if (
        disposed ||
        !deps.canWrite() ||
        !card ||
        entry.posting ||
        entry.pending ||
        entry.loading ||
        entry.error ||
        entry.page!.revision < entry.fence ||
        entry.receipts.has(cardId) ||
        card.record ||
        (operation === "approve" &&
          !card.available &&
          !(
            card.destinationAvailable &&
            entry.drafts.has(cardId) &&
            JSON.stringify(entry.drafts.get(cardId)) !==
              JSON.stringify(card.proposal.draft)
          ))
      )
        return;
      const draft =
        operation === "dismiss"
          ? card.proposal.draft
          : (entry.drafts.get(cardId) ?? card.proposal.draft);
      const parsed = keeperProposalApprovalSchema.safeParse({
        id: cardId,
        sourceHash: card.proposal.sourceHash,
        requestId: deps.requestId(),
        expectedRevision: entry.page!.revision,
        draft,
      });
      if (!parsed.success) {
        entry.notice =
          "Review the entered values before approving. The draft is incomplete or exceeds the supported limits.";
        tell();
        return;
      }
      const { draft: reviewed, ...address } = parsed.data;
      entry.pending = {
        operation,
        uncertain: false,
        body:
          operation === "approve" ? { ...address, draft: reviewed } : address,
      };
      await send(id);
    },
    retry: send,
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}
export type KeeperProposalsClient = ReturnType<
  typeof createKeeperProposalsClient
>;
