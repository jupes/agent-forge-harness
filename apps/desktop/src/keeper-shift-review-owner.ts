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
  visible: boolean;
  readGeneration: number;
  deliveryGeneration: number;
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
  const tell = (entry?: KeeperShiftReviewEntry) => {
    if (!disposed && (!entry || entry.visible))
      for (const listener of [...listeners]) listener();
  };
  const keyOf = (source: KeeperProposal) =>
    `${source.projectId}:${source.id}:${source.sourceHash}`;
  const isReadCurrent = (entry: KeeperShiftReviewEntry, generation: number) =>
    !disposed &&
    entry.visible &&
    entries.get(keyOf(entry.state.source)) === entry &&
    entry.readGeneration === generation;
  const isDeliveryCurrent = (
    entry: KeeperShiftReviewEntry,
    generation: number,
  ) =>
    entries.get(keyOf(entry.state.source)) === entry &&
    entry.deliveryGeneration === generation;
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
    if (!isReadCurrent(entry, generation)) return;
    if (raw === null) {
      hold(
        entry,
        "The protected original is not available. Its UUID is kept; no replacement or automatic replay is allowed.",
      );
      return;
    }
    const accepted = await acceptKeeperShiftReceipt(entry.state, raw);
    if (isReadCurrent(entry, generation)) entry.state = accepted;
  };
  const open = async (entry: KeeperShiftReviewEntry) => {
    if (disposed) return;
    entry.visible = true;
    if (entry.starting) {
      tell(entry);
      return;
    }
    const generation = ++entry.readGeneration;
    entry.loading = true;
    tell(entry);
    try {
      const savedIdentity = deps.identities.read(entry.state.source);
      if (!isReadCurrent(entry, generation)) return;
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
      if (!isReadCurrent(entry, generation)) return;
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
      if (isReadCurrent(entry, generation))
        hold(
          entry,
          error instanceof Error
            ? `${error.message} The saved identity is kept; check the original before continuing.`
            : "The current Shift review could not be checked. Its saved identity is kept.",
        );
    } finally {
      if (isReadCurrent(entry, generation)) {
        entry.loading = false;
        tell(entry);
      }
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
    if (!isDeliveryCurrent(entry, generation)) return;
    if (outcome.state === "done") {
      try {
        const accepted = await acceptKeeperShiftReceipt(
          entry.state,
          outcome.data,
        );
        if (isDeliveryCurrent(entry, generation)) entry.state = accepted;
      } catch (error) {
        if (isDeliveryCurrent(entry, generation))
          hold(
            entry,
            error instanceof Error
              ? `${error.message} ${checkMessage}`
              : `The Start reply could not be verified. ${checkMessage}`,
          );
      }
    } else hold(entry, outcome.message);
    tell(entry);
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
          visible: false,
          readGeneration: 0,
          deliveryGeneration: 0,
        };
        entries.set(key, entry);
      }
      if (JSON.stringify(source) !== JSON.stringify(entry.state.source)) {
        hold(
          entry,
          "The proposal source changed without a new source identity. Check the current Keeper reply before continuing.",
        );
        tell(entry);
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
      tell(entry);
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
      const generation = ++entry.deliveryGeneration;
      const reviewSnapshot = JSON.stringify({
        source: entry.state.source,
        revision: entry.state.revision,
        options: entry.state.options,
        workspace: entry.state.workspace,
        draft: entry.state.draft,
      });
      tell(entry);
      try {
        const id = deps.requestId();
        const frozen = structuredClone(entry.state);
        const built = await buildKeeperShiftStart(frozen, id);
        if (!isDeliveryCurrent(entry, generation)) return;
        if (!built.ok) {
          entry.state = { ...entry.state, notice: built.reason };
          return;
        }
        const currentSnapshot = JSON.stringify({
          source: entry.state.source,
          revision: entry.state.revision,
          options: entry.state.options,
          workspace: entry.state.workspace,
          draft: entry.state.draft,
        });
        if (
          currentSnapshot !== reviewSnapshot ||
          entry.state.status !== "ready" ||
          entry.state.requestId !== null ||
          entry.state.original !== null
        ) {
          entry.state = {
            ...entry.state,
            status: "held",
            notice:
              "The proposal review changed while its Start was being prepared. Reopen and review the current options before starting.",
          };
          return;
        }
        // Retain this complete body in the app-root owner before awaiting storage.
        // Only the UUID and proposal metadata enter local storage.
        entry.state = {
          ...entry.state,
          original: structuredClone(built.request),
          status: "held",
          notice: "Saving the exact reviewed Start identity before delivery.",
        };
        tell(entry);
        const reserved = await deps.identities.reserve(
          frozen.source,
          frozen.workspace as string,
          () => id,
        );
        if (!isDeliveryCurrent(entry, generation)) return;
        if (reserved.identity.requestId !== id || !reserved.created) {
          entry.state = {
            ...entry.state,
            requestId: reserved.identity.requestId,
            original: null,
            status: "held",
            notice:
              "A Shift identity was already saved. Check that exact protected original before continuing.",
          };
          return;
        }
        entry.state = {
          ...entry.state,
          requestId: id,
          status: "held",
          notice: "The exact reviewed Start is being sent once.",
        };
        if (!deps.canWrite()) {
          hold(entry, `The connection changed before Start. ${checkMessage}`);
          return;
        }
        await sendOriginal(entry, built.request, generation);
      } catch (error) {
        if (isDeliveryCurrent(entry, generation))
          hold(
            entry,
            error instanceof Error
              ? `${error.message} ${checkMessage}`
              : `The original identity could not be confirmed. ${checkMessage}`,
          );
      } finally {
        entry.starting = false;
        if (isDeliveryCurrent(entry, generation)) tell(entry);
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
        !["held", "unknown"].includes(entry.state.status) ||
        !deps.canWrite()
      )
        return;
      entry.starting = true;
      const generation = ++entry.deliveryGeneration;
      tell(entry);
      try {
        const held = requestId
          ? deps.identities.read(entry.state.source, workspace)
          : await deps.identities.reserve(
              entry.state.source,
              workspace,
              () => original.start.requestId,
            );
        if (!isDeliveryCurrent(entry, generation)) return;
        const heldIdentity = held && "identity" in held ? held.identity : held;
        if (
          !heldIdentity ||
          heldIdentity.requestId !== original.start.requestId
        ) {
          entry.state = {
            ...entry.state,
            requestId: heldIdentity?.requestId ?? null,
            original: null,
            status: "held",
            notice:
              "The saved Shift identity does not match its exact original. No request was sent.",
          };
          return;
        }
        entry.state = {
          ...entry.state,
          requestId: original.start.requestId,
          status: "held",
        };
        if (!deps.canWrite()) {
          hold(entry, `The connection changed before Start. ${checkMessage}`);
          return;
        }
        await sendOriginal(entry, original, generation);
      } catch (error) {
        if (isDeliveryCurrent(entry, generation))
          hold(
            entry,
            error instanceof Error
              ? `${error.message} ${checkMessage}`
              : `The original Shift identity could not be verified. ${checkMessage}`,
          );
      } finally {
        entry.starting = false;
        if (isDeliveryCurrent(entry, generation)) tell(entry);
      }
    },
    close(entry: KeeperShiftReviewEntry) {
      entry.visible = false;
      entry.readGeneration += 1;
      entry.loading = false;
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
