import type { ActionOutcome } from "../../../docs/js/action-outcome";
import { projectShiftOptionsSchema } from "../../../scripts/shifts/protocol";
import type { KeeperProposal } from "../../../types/keeper-proposal";
import type { KeeperShiftStartRequest } from "../../../types/keeper-shift-start";
import type { KeeperShiftIdentities } from "./keeper-shift-identities";
import {
  acceptKeeperShiftReceipt,
  buildKeeperShiftStart,
  createKeeperShiftReview,
  editKeeperShiftDraft,
  holdKeeperShiftReview,
  initializeKeeperShiftReview,
  type KeeperShiftReviewState,
} from "./keeper-shift-review";

export interface KeeperShiftReviewEntry {
  state: KeeperShiftReviewState;
  loading: boolean;
  starting: boolean;
  generation: number;
}

const checkMessage =
  "Check the original Keeper Shift request; it will not be replayed automatically.";

/** One app-root owner for Keeper Shift review, its original identity and explicit transport. */
export function createKeeperShiftReviewOwner(deps: {
  canWrite(): boolean;
  requestId(): string;
  identities: KeeperShiftIdentities;
  readOptions(projectId: string): Promise<unknown>;
  readOriginal(
    projectId: string,
    proposalId: string,
    requestId: string,
  ): Promise<unknown | null>;
  postStart(
    projectId: string,
    proposalId: string,
    request: KeeperShiftStartRequest,
  ): Promise<ActionOutcome>;
}) {
  const entries = new Map<string, KeeperShiftReviewEntry>();
  const listeners = new Set<() => void>();
  let disposed = false;
  const tell = () => {
    if (!disposed) for (const listener of [...listeners]) listener();
  };
  const keyOf = (source: KeeperProposal) =>
    `${source.projectId}:${source.id}:${source.sourceHash}`;
  const isCurrent = (entry: KeeperShiftReviewEntry, generation: number) =>
    !disposed &&
    entries.get(keyOf(entry.state.source)) === entry &&
    entry.generation === generation;
  const hold = (entry: KeeperShiftReviewEntry, notice: string) => {
    entry.state = holdKeeperShiftReview(entry.state, notice);
  };
  const readOriginal = async (
    entry: KeeperShiftReviewEntry,
    requestId: string,
    generation: number,
  ) => {
    const raw = await deps.readOriginal(
      entry.state.source.projectId,
      entry.state.source.id,
      requestId,
    );
    if (!isCurrent(entry, generation)) return;
    if (raw === null) {
      hold(
        entry,
        "The protected original is not available. Its UUID is kept; no replacement or automatic replay is allowed.",
      );
      return;
    }
    const accepted = await acceptKeeperShiftReceipt(entry.state, raw);
    if (isCurrent(entry, generation)) entry.state = accepted;
  };
  const open = async (entry: KeeperShiftReviewEntry) => {
    if (disposed || entry.loading || entry.starting) return;
    const generation = ++entry.generation;
    entry.loading = true;
    tell();
    try {
      const savedIdentity = deps.identities.read(entry.state.source);
      if (!isCurrent(entry, generation)) return;
      if (savedIdentity && entry.state.requestId === null)
        entry.state = {
          ...entry.state,
          requestId: savedIdentity.requestId,
          status: "held",
          notice:
            "A Shift identity is already saved. Verify the current project scope before checking its original.",
        };
      const checked = projectShiftOptionsSchema.safeParse(
        await deps.readOptions(entry.state.source.projectId),
      );
      if (!isCurrent(entry, generation)) return;
      if (
        !checked.success ||
        checked.data.projectId !== entry.state.source.projectId
      )
        throw Error("Current Shift options belong to another project.");
      const held = deps.identities.read(
        entry.state.source,
        checked.data.workspace,
      );
      if (
        entry.state.requestId !== null &&
        (!held || held.requestId !== entry.state.requestId)
      )
        throw Error(
          "The saved Shift identity could not be matched to this protected original.",
        );
      const requestId = held?.requestId ?? null;
      entry.state = initializeKeeperShiftReview(
        entry.state,
        checked.data,
        requestId,
      );
      if (requestId !== null) await readOriginal(entry, requestId, generation);
    } catch (error) {
      if (isCurrent(entry, generation))
        hold(
          entry,
          error instanceof Error
            ? `${error.message} The saved identity is kept; check the original before continuing.`
            : "The current Shift review could not be checked. Its saved identity is kept.",
        );
    } finally {
      entry.loading = false;
      if (isCurrent(entry, generation)) tell();
    }
  };
  const sendOriginal = async (
    entry: KeeperShiftReviewEntry,
    request: KeeperShiftStartRequest,
    generation: number,
  ) => {
    let outcome: ActionOutcome;
    try {
      outcome = await deps.postStart(
        entry.state.source.projectId,
        entry.state.source.id,
        structuredClone(request),
      );
    } catch (error) {
      outcome = {
        state: "unknown",
        message:
          error instanceof Error
            ? `${error.message} ${checkMessage}`
            : `The Start reply was lost. ${checkMessage}`,
      };
    }
    if (!isCurrent(entry, generation)) return;
    if (outcome.state === "done") {
      try {
        const accepted = await acceptKeeperShiftReceipt(
          entry.state,
          outcome.data,
        );
        if (isCurrent(entry, generation)) entry.state = accepted;
      } catch (error) {
        if (isCurrent(entry, generation))
          hold(
            entry,
            error instanceof Error
              ? `${error.message} ${checkMessage}`
              : `The Start reply could not be verified. ${checkMessage}`,
          );
      }
    } else hold(entry, outcome.message);
  };

  return {
    get(source: KeeperProposal, revision: number): KeeperShiftReviewEntry {
      const key = keyOf(source);
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          state: createKeeperShiftReview(source, revision),
          loading: false,
          starting: false,
          generation: 0,
        };
        entries.set(key, entry);
      }
      if (!entry.state.original && !entry.state.requestId)
        entry.state = {
          ...entry.state,
          revision: Math.max(entry.state.revision, revision),
        };
      return entry;
    },
    open,
    edit(
      entry: KeeperShiftReviewEntry,
      update: Parameters<typeof editKeeperShiftDraft>[1],
    ) {
      if (disposed || entry.loading || entry.starting) return;
      entry.state = editKeeperShiftDraft(entry.state, update);
      tell();
    },
    async start(entry: KeeperShiftReviewEntry) {
      if (
        disposed ||
        entry.loading ||
        entry.starting ||
        entry.state.status !== "ready" ||
        !entry.state.workspace ||
        !deps.canWrite()
      )
        return;
      entry.starting = true;
      const generation = ++entry.generation;
      tell();
      try {
        const id = deps.requestId();
        const built = await buildKeeperShiftStart(entry.state, id);
        if (!isCurrent(entry, generation)) return;
        if (!built.ok) {
          entry.state = { ...entry.state, notice: built.reason };
          return;
        }
        const reserved = await deps.identities.reserve(
          entry.state.source,
          entry.state.workspace,
          () => id,
        );
        if (!isCurrent(entry, generation)) return;
        if (reserved.identity.requestId !== id || !reserved.created) {
          entry.state = {
            ...entry.state,
            requestId: reserved.identity.requestId,
            status: "held",
            notice:
              "A Shift identity was already saved. Check that exact protected original before continuing.",
          };
          return;
        }
        entry.state = {
          ...entry.state,
          requestId: id,
          original: structuredClone(built.request),
          status: "held",
          notice: "The exact reviewed Start is being sent once.",
        };
        if (!isCurrent(entry, generation) || !deps.canWrite()) {
          hold(entry, `The connection changed before Start. ${checkMessage}`);
          return;
        }
        await sendOriginal(entry, built.request, generation);
      } catch (error) {
        if (isCurrent(entry, generation))
          hold(
            entry,
            error instanceof Error
              ? `${error.message} ${checkMessage}`
              : `The original identity could not be confirmed. ${checkMessage}`,
          );
      } finally {
        entry.starting = false;
        if (isCurrent(entry, generation)) tell();
      }
    },
    async check(entry: KeeperShiftReviewEntry) {
      await open(entry);
    },
    async retry(entry: KeeperShiftReviewEntry) {
      const original = entry.state.original,
        workspace = entry.state.workspace,
        requestId = entry.state.requestId;
      if (
        disposed ||
        entry.loading ||
        entry.starting ||
        !original ||
        !workspace ||
        !requestId ||
        !["held", "unknown"].includes(entry.state.status) ||
        !deps.canWrite()
      )
        return;
      entry.starting = true;
      const generation = ++entry.generation;
      tell();
      try {
        const held = deps.identities.read(entry.state.source, workspace);
        if (!held || held.requestId !== requestId)
          throw Error("The saved Shift identity does not match its original.");
        await sendOriginal(entry, original, generation);
      } catch (error) {
        if (isCurrent(entry, generation))
          hold(
            entry,
            error instanceof Error
              ? `${error.message} ${checkMessage}`
              : `The original Shift identity could not be verified. ${checkMessage}`,
          );
      } finally {
        entry.starting = false;
        if (isCurrent(entry, generation)) tell();
      }
    },
    close(entry: KeeperShiftReviewEntry) {
      entry.generation += 1;
      if (entry.state.requestId || entry.state.original)
        hold(entry, `This review is closed. ${checkMessage}`);
      tell();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };
}

export type KeeperShiftReviewOwner = ReturnType<
  typeof createKeeperShiftReviewOwner
>;
