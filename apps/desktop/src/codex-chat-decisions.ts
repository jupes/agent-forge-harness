import type { ActionOutcome } from "../../../docs/js/action-outcome";
import {
  codexChatApprovalPageSchema,
  codexChatDecisionReceiptSchema,
} from "../../../scripts/sessions/codex-chat-owned-protocol";
import type { CodexChatDecision } from "../../../types/codex-chat";
import type {
  CodexChatApprovalPage,
  CodexChatDecisionReceipt,
  CodexChatDecisionRequest,
} from "../../../types/codex-owned-chat";
import {
  type CodexChatDecisionIdentities,
  type CodexChatDecisionIdentity,
  decisionBody,
} from "./codex-chat-decision-identities";

export interface CodexChatDecisionView {
  projectId: string;
  sessionId: string;
  turnRequestId: string | null;
  actionable: boolean;
  pending: CodexChatApprovalPage["pending"];
  identity: CodexChatDecisionIdentity | null;
  identityError: string;
  error: string;
  notice: string;
  loading: boolean;
  checking: boolean;
  posting: boolean;
  receipt: CodexChatDecisionReceipt | null;
}
type Address = {
  projectId: string;
  sessionId: string;
  turnRequestId: string | null;
  actionable: boolean;
};
/** Owns original decisions, never native callbacks. History reads cannot resend or answer a live offer. */
export function createCodexChatDecisions(deps: {
  identities: CodexChatDecisionIdentities;
  canWrite(): boolean;
  requestId(): string;
  read(
    projectId: string,
    sessionId: string,
    requestId?: string,
  ): Promise<unknown>;
  post(
    projectId: string,
    sessionId: string,
    input: CodexChatDecisionRequest,
  ): Promise<ActionOutcome>;
}) {
  const entries = new Map<string, CodexChatDecisionView>(),
    listeners = new Set<() => void>();
  let selected: CodexChatDecisionView | null = null,
    generation = 0,
    disposed = false;
  const tell = () => {
    if (!disposed) for (const listener of [...listeners]) listener();
  };
  const hydrate = (entry: CodexChatDecisionView) => {
    if (entry.identityError && entry.identity) return;
    try {
      entry.identity = deps.identities.read(entry.projectId, entry.sessionId);
      entry.identityError = "";
    } catch {
      entry.identityError =
        "Original approval decisions could not be verified. Saved data was kept; another decision is blocked.";
    }
  };
  const entryFor = (address: Address) => {
    const key = `${address.projectId}:${address.sessionId}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        ...address,
        pending: [],
        identity: null,
        identityError: "",
        error: "",
        notice: "",
        loading: false,
        checking: false,
        posting: false,
        receipt: null,
      };
      entries.set(key, entry);
      hydrate(entry);
    }
    return entry;
  };
  const live = (entry: CodexChatDecisionView) =>
    !disposed &&
    selected === entry &&
    entry.actionable &&
    !!entry.turnRequestId &&
    deps.canWrite();
  const confirm = async (entry: CodexChatDecisionView, raw: unknown) => {
    const parsed = codexChatDecisionReceiptSchema.safeParse(raw),
      identity = entry.identity;
    if (
      !identity ||
      !parsed.success ||
      parsed.data.projectId !== identity.projectId ||
      parsed.data.sessionId !== identity.sessionId ||
      JSON.stringify(decisionBody(parsed.data)) !==
        JSON.stringify(decisionBody(identity))
    )
      throw Error(
        "The answer did not confirm this original approval decision.",
      );
    try {
      await deps.identities.release(identity);
    } catch {
      entry.identityError =
        "The recorded decision could not be cleared from browser storage. The original is still held.";
      throw Error(entry.identityError);
    }
    entry.receipt = parsed.data;
    entry.identity = null;
    entry.identityError = "";
    entry.notice =
      "The original decision intent is recorded. This does not confirm native delivery or execution.";
  };
  const client = {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    activate(address: Address | null) {
      const next = address ? entryFor(address) : null;
      if (
        selected === next &&
        next &&
        address &&
        next.turnRequestId === address.turnRequestId &&
        next.actionable === address.actionable
      )
        return;
      if (selected) selected.pending = [];
      generation++;
      selected = next;
      if (next && address) {
        Object.assign(next, address, { pending: [], loading: false });
        hydrate(next);
      }
      tell();
    },
    view() {
      return selected;
    },
    refreshIdentities() {
      for (const entry of entries.values()) hydrate(entry);
      tell();
    },
    invalidate() {
      generation++;
      if (selected) {
        selected.pending = [];
        selected.actionable = false;
        selected.loading = false;
      }
      tell();
    },
    async refreshPending() {
      const entry = selected;
      if (!entry || !live(entry) || entry.posting) return;
      const current = ++generation,
        turn = entry.turnRequestId;
      // A same-scope background check must not remove a choice being read or
      // keyboard-focused. Invalid scope, Stop and failed reads clear it below.
      entry.loading = entry.pending.length === 0;
      entry.error = "";
      tell();
      try {
        const page = codexChatApprovalPageSchema.parse(
          await deps.read(entry.projectId, entry.sessionId),
        );
        if (
          current !== generation ||
          !live(entry) ||
          turn !== entry.turnRequestId
        )
          return;
        if (
          page.receipt ||
          page.pending.some((item) => item.turnRequestId !== turn) ||
          new Set(page.pending.map((item) => item.approval.id)).size !==
            page.pending.length
        )
          throw Error(
            "The live approval page did not match this accepted turn.",
          );
        entry.pending = page.pending;
      } catch {
        if (current === generation) {
          entry.pending = [];
          entry.error =
            "Live native approvals could not be verified. Refresh before choosing a decision.";
        }
      } finally {
        if (current === generation) entry.loading = false;
        tell();
      }
    },
    async checkOriginal() {
      const entry = selected;
      if (!entry || entry.checking || entry.posting) return;
      hydrate(entry);
      const identity = entry.identity;
      if (!identity) return;
      entry.checking = true;
      entry.error = "";
      tell();
      try {
        const page = codexChatApprovalPageSchema.parse(
          await deps.read(entry.projectId, entry.sessionId, identity.requestId),
        );
        if (page.pending.length)
          throw Error(
            "An original receipt read cannot advertise live approvals.",
          );
        if (page.receipt) await confirm(entry, page.receipt);
        else
          entry.notice =
            "The original decision is not confirmed. It remains held; it was not resent.";
      } catch {
        entry.error =
          "The original decision could not be confirmed. It remains held; it was not resent.";
      } finally {
        entry.checking = false;
        tell();
      }
    },
    async decide(approvalId: string, decision: CodexChatDecision) {
      const entry = selected;
      if (
        !entry ||
        !live(entry) ||
        entry.posting ||
        entry.checking ||
        entry.loading
      )
        return;
      hydrate(entry);
      if (entry.identity || entry.identityError) {
        tell();
        return;
      }
      const offered = entry.pending.find(
        (item) =>
          item.approval.id === approvalId &&
          item.turnRequestId === entry.turnRequestId,
      );
      if (!offered || !offered.approval.availableDecisions.includes(decision))
        return;
      const turn = offered.turnRequestId,
        current = generation;
      entry.posting = true;
      entry.error = "";
      tell();
      try {
        const reserved = await deps.identities.reserve(
          {
            projectId: entry.projectId,
            sessionId: entry.sessionId,
            turnRequestId: turn,
            approvalId,
            decision,
          },
          deps.requestId,
        );
        entry.identity = reserved.identity;
        if (!reserved.created) {
          entry.notice =
            "An original approval decision is saved. Check its receipt before another decision.";
          return;
        }
        if (
          !live(entry) ||
          entry.turnRequestId !== turn ||
          generation !== current ||
          !entry.pending.some(
            (item) => JSON.stringify(item) === JSON.stringify(offered),
          )
        ) {
          // This process has not dispatched: only this proven-unsent reservation can be released locally.
          await deps.identities.release(reserved.identity);
          entry.identity = null;
          entry.notice =
            "The live approval changed before dispatch. No decision was sent.";
          return;
        }
        entry.pending = [];
        // A pre-dispatch read must not repopulate an offer consumed by this
        // original, even if its protected answer arrives after the POST.
        generation++;
        const result = await deps.post(
          entry.projectId,
          entry.sessionId,
          decisionBody(reserved.identity),
        );
        if (result.state === "done") await confirm(entry, result.data);
        else
          entry.notice =
            "The original approval decision is unconfirmed. Check its protected receipt; it will not be resent automatically.";
      } catch {
        entry.error =
          "The original approval decision could not be completed or verified. Saved data was kept; check the original receipt.";
        hydrate(entry);
      } finally {
        entry.posting = false;
        tell();
      }
    },
    dispose() {
      disposed = true;
      generation++;
      selected = null;
      for (const entry of entries.values()) entry.pending = [];
      listeners.clear();
    },
  };
  return client;
}
export type CodexChatDecisions = ReturnType<typeof createCodexChatDecisions>;
