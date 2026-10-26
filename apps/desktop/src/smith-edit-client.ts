import { z } from "zod";
import {
  smithConfigEditPreviewSchema,
  smithConfigEditReceiptSchema,
  smithConfigEditRequestSchema,
} from "../../../scripts/config/smith-edit-protocol";
import type { Smith } from "../../../types/hearth";
import type {
  SmithConfigEditPreview,
  SmithConfigEditPreviewRequest,
  SmithConfigEditReceipt,
  SmithConfigEditRequest,
  SmithConfigEditTarget,
} from "../../../types/smith-config-edit";
import {
  isVerifiedSmithEditNotSent,
  type SmithEditPostResult,
} from "./smith-edit-api";
import {
  type SmithEditIdentities,
  type SmithEditIdentity,
  smithConfigEditInputHash,
} from "./smith-edit-identities";

export interface SmithEditEntry {
  identity: SmithEditIdentity;
  request: SmithConfigEditRequest | null;
  receipt: SmithConfigEditReceipt | null;
  state: "held" | "confirmed" | "refused" | "not-sent";
  checking: boolean;
  notice: string;
}

export interface SmithEditClientState {
  target: SmithConfigEditTarget;
  name: string;
  smith: Smith;
  preview: SmithConfigEditPreview | null;
  previewing: boolean;
  saving: boolean;
  entries: SmithEditEntry[];
  activeRequestId: string | null;
  notice: string;
}

type ReceiptInstall = "installed" | "invalid" | "terminal-conflict";

const sameSmith = (left: Smith, right: Smith) =>
  left.name === right.name &&
  left.provider === right.provider &&
  left.model === right.model &&
  left.effort === right.effort &&
  left.enabled === right.enabled &&
  left.tags.length === right.tags.length &&
  left.tags.every((tag, index) => tag === right.tags[index]);

const samePreviewInput = (
  preview: SmithConfigEditPreview | null,
  target: SmithConfigEditTarget,
  name: string,
  smith: Smith,
) =>
  !!preview &&
  preview.target === target &&
  preview.review.name === name &&
  preview.review.effectiveAfter.name === name &&
  sameSmith(preview.review.effectiveAfter, smith) &&
  sameSmith(preview.review.targetAfter, smith);

function envelopeValue(value: unknown): unknown {
  const envelope = z
    .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
    .strict()
    .safeParse(value);
  return envelope.success ? envelope.data.data : value;
}

function terminalPhase(
  entry: SmithEditEntry,
): "confirmed" | "refused" | "not-sent" | null {
  if (entry.identity.retirement === "correlated-confirmation")
    return "confirmed";
  if (entry.identity.retirement === "correlated-refusal") return "refused";
  if (entry.identity.retirement === "verified-not-sent") return "not-sent";
  if (entry.state === "not-sent") return "not-sent";
  return entry.receipt?.result.phase === "confirmed" ||
    entry.receipt?.result.phase === "refused"
    ? entry.receipt.result.phase
    : null;
}

/** App-root edit owner. The dialog is only a view; saved originals are never replayed. */
export function createSmithConfigEditClient(deps: {
  identities(scope: string): SmithEditIdentities;
  scope(): string;
  canWrite(): boolean;
  requestId(): string;
  preview(input: SmithConfigEditPreviewRequest): Promise<unknown>;
  post(request: SmithConfigEditRequest): Promise<SmithEditPostResult>;
  readOriginal(requestId: string): Promise<unknown>;
  changed?(): void;
}) {
  const state: SmithEditClientState = {
    target: "workspace",
    name: "",
    smith: {
      name: "",
      provider: "",
      model: "",
      effort: "",
      enabled: true,
      tags: [],
    },
    preview: null,
    previewing: false,
    saving: false,
    entries: [],
    activeRequestId: null,
    notice: "",
  };
  const listeners = new Set<() => void>();
  let disposed = false;
  let generation = 0;
  let observedScope = deps.scope();
  let previewScope: string | null = null;
  const emit = () => {
    if (disposed) return;
    deps.changed?.();
    for (const listener of listeners) listener();
  };
  const store = (scope = deps.scope()) => deps.identities(scope);
  const current = (ticket: number, scope: string) =>
    !disposed &&
    ticket === generation &&
    deps.canWrite() &&
    deps.scope() === scope;
  const entry = (id: string, scope = deps.scope()) =>
    state.entries.find(
      (item) => item.identity.scope === scope && item.identity.requestId === id,
    );
  const observeScope = () => {
    const scope = deps.scope();
    if (scope === observedScope) return scope;
    observedScope = scope;
    generation++;
    previewScope = null;
    state.preview = null;
    state.activeRequestId = null;
    state.notice =
      "Workspace changed. Review the selected Smith again before saving.";
    emit();
    return scope;
  };
  const canStart = () => {
    try {
      return !store()
        .list()
        .some((identity) => {
          if (identity.retired) return false;
          const currentEntry = entry(identity.requestId);
          return currentEntry === undefined || currentEntry.state === "held";
        });
    } catch {
      return false;
    }
  };

  const installReceipt = async (
    held: SmithEditEntry,
    raw: unknown,
  ): Promise<ReceiptInstall> => {
    const parsed = smithConfigEditReceiptSchema.safeParse(envelopeValue(raw));
    let saved: SmithEditIdentity | null = null;
    try {
      saved = store(held.identity.scope).read(held.identity.requestId);
    } catch {
      // Unavailable metadata cannot be replaced by an unverified response.
    }
    if (
      !parsed.success ||
      !saved ||
      parsed.data.requestId !== held.identity.requestId ||
      parsed.data.original.requestId !== held.identity.requestId ||
      parsed.data.original.target !== held.identity.target ||
      parsed.data.original.name !== held.identity.name ||
      parsed.data.original.smith.name !== held.identity.name ||
      parsed.data.inputHash !== held.identity.inputHash ||
      saved.scope !== held.identity.scope ||
      saved.target !== held.identity.target ||
      saved.name !== held.identity.name ||
      saved.inputHash !== held.identity.inputHash ||
      (await smithConfigEditInputHash(parsed.data.original)) !==
        held.identity.inputHash
    ) {
      held.notice =
        "The original Smith edit could not be verified. Its UUID remains held; check the original again.";
      return "invalid";
    }
    const previousTerminal = terminalPhase(held);
    if (previousTerminal && parsed.data.result.phase !== previousTerminal) {
      held.notice = `The protected receipt conflicts with the saved ${previousTerminal} outcome. That outcome remains saved; no edit was resent.`;
      return "terminal-conflict";
    }
    held.receipt = structuredClone(parsed.data);
    held.request ??= structuredClone(parsed.data.original);
    held.state = parsed.data.result.phase;
    held.notice =
      parsed.data.result.phase === "confirmed"
        ? "Smith configuration updated. The saved original receipt is available for review."
        : parsed.data.result.phase === "refused"
          ? `Smith edit was refused before publication: ${parsed.data.result.reason}. Review again before starting a new edit.`
          : "Smith edit outcome is held. Check this original request; it will not be sent again automatically.";
    return "installed";
  };

  const retire = async (
    held: SmithEditEntry,
    proof: NonNullable<SmithEditIdentity["retirement"]>,
  ) => {
    try {
      held.identity = await store(held.identity.scope).retire(
        held.identity,
        proof,
      );
      return true;
    } catch {
      held.state = "held";
      held.notice =
        "The settlement could not be saved and verified. Its UUID remains held; check the same original receipt.";
      return false;
    }
  };

  const retireVerifiedReceipt = async (held: SmithEditEntry) => {
    if (held.state !== "confirmed" && held.state !== "refused") return true;
    return retire(
      held,
      held.state === "confirmed"
        ? "correlated-confirmation"
        : "correlated-refusal",
    );
  };

  const client = {
    get(): SmithEditClientState {
      observeScope();
      return {
        ...structuredClone(state),
        entries: structuredClone(
          state.entries.filter((item) => item.identity.scope === observedScope),
        ),
      };
    },
    canStart(): boolean {
      return !disposed && !!deps.canWrite() && canStart();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDraft(target: SmithConfigEditTarget, name: string, smith: Smith) {
      observeScope();
      const valid = smith.name === name;
      const changed =
        target !== state.target ||
        name !== state.name ||
        !sameSmith(state.smith, smith);
      if (!changed) return;
      state.target = target;
      state.name = name;
      state.smith = structuredClone(smith);
      state.preview = null;
      previewScope = null;
      state.notice = valid
        ? "Draft changed. Review a fresh candidate before saving."
        : "The selected Smith name is immutable. No edit can be saved for a different name.";
      generation++;
      emit();
    },
    async preview() {
      const scope = observeScope();
      if (disposed || state.previewing || state.saving || !deps.canWrite())
        return;
      if (state.smith.name !== state.name || !canStart()) {
        state.preview = null;
        previewScope = null;
        state.notice =
          state.smith.name !== state.name
            ? "The selected Smith name is immutable. No edit can be saved for a different name."
            : "Saved Smith edit identities could not be verified. No new edit can start.";
        emit();
        return;
      }
      const draft = {
        target: state.target,
        name: state.name,
        smith: structuredClone(state.smith),
      };
      const ticket = generation;
      state.previewing = true;
      state.notice = "Preparing a fresh candidate for review…";
      emit();
      try {
        const raw = await deps.preview(draft);
        const parsed = smithConfigEditPreviewSchema.safeParse(
          envelopeValue(raw),
        );
        if (!current(ticket, scope)) return;
        if (
          !parsed.success ||
          parsed.data.target !== draft.target ||
          parsed.data.review.name !== draft.name ||
          !sameSmith(parsed.data.review.targetAfter, draft.smith) ||
          !sameSmith(parsed.data.review.effectiveAfter, draft.smith)
        )
          throw Error(
            "The Smith edit candidate did not match the reviewed draft.",
          );
        state.preview = structuredClone(parsed.data);
        previewScope = scope;
        state.notice =
          "Review the complete target and effective changes before saving.";
      } catch {
        if (current(ticket, scope)) {
          state.preview = null;
          previewScope = null;
          state.notice =
            "The Smith edit candidate could not be verified. No edit request was sent.";
        }
      } finally {
        state.previewing = false;
        emit();
      }
    },
    async save() {
      const scope = observeScope();
      if (
        disposed ||
        state.saving ||
        state.previewing ||
        !deps.canWrite() ||
        !canStart() ||
        previewScope !== scope ||
        !samePreviewInput(state.preview, state.target, state.name, state.smith)
      )
        return;
      const reviewed = state.preview!;
      let request: SmithConfigEditRequest;
      try {
        request = smithConfigEditRequestSchema.parse({
          requestId: deps.requestId(),
          target: state.target,
          name: state.name,
          smith: state.smith,
          expectedRevision: reviewed.expectedRevision,
        });
      } catch {
        state.notice = "The reviewed Smith edit request could not be verified.";
        emit();
        return;
      }
      const ticket = generation;
      state.saving = true;
      state.notice = "Saving the original edit identity before sending…";
      emit();
      try {
        let reserved: Awaited<ReturnType<SmithEditIdentities["reserve"]>>;
        try {
          reserved = await store(scope).reserve(request);
        } catch (error) {
          state.notice =
            error instanceof Error
              ? `${error.message} No edit request was sent.`
              : "The original edit identity could not be verified. No request was sent.";
          return;
        }
        let held = entry(reserved.identity.requestId, scope);
        if (!held) {
          held = {
            identity: reserved.identity,
            request: structuredClone(request),
            receipt: null,
            state: "held",
            checking: false,
            notice: "Original edit identity saved before delivery.",
          };
          state.entries.push(held);
        }
        state.activeRequestId = reserved.identity.requestId;
        if (!reserved.created) {
          state.preview = null;
          previewScope = null;
          state.notice =
            "This request UUID is already held. Check its original receipt before saving anything else.";
          return;
        }
        if (
          !current(ticket, scope) ||
          !samePreviewInput(
            state.preview,
            state.target,
            state.name,
            state.smith,
          )
        ) {
          const retired = await retire(held, "verified-not-sent");
          if (retired) {
            held.state = "not-sent";
            held.notice =
              "The original identity is saved, and the request was not sent. Review again before starting a new edit.";
          }
          state.preview = null;
          previewScope = null;
          state.notice = held.notice;
          return;
        }
        let outcome: SmithEditPostResult;
        try {
          outcome = await deps.post(structuredClone(request));
        } catch {
          outcome = {
            state: "unknown",
            message: "The request may have reached the server.",
          };
        }
        if (
          !current(ticket, scope) &&
          !isVerifiedSmithEditNotSent(outcome, request.requestId)
        ) {
          held.state = "held";
          held.notice =
            "The workspace changed while the request was in progress. Its original UUID remains held for later receipt recovery.";
          state.preview = null;
          state.notice = held.notice;
          return;
        }
        if (isVerifiedSmithEditNotSent(outcome, request.requestId)) {
          const retired = await retire(held, "verified-not-sent");
          if (retired) {
            held.state = "not-sent";
            held.notice = `${outcome.message} No edit request was sent.`;
          }
          state.notice = held.notice;
        } else if (outcome.state === "unknown") {
          held.state = "held";
          held.notice =
            "The edit outcome is unknown. Check this original request; it will not be sent again automatically.";
          state.notice = held.notice;
        } else {
          let installed: ReceiptInstall = "invalid";
          try {
            installed = await installReceipt(held, outcome.value);
          } catch {
            held.notice =
              "The edit response could not be checked. Its UUID remains held; check the original receipt.";
          }
          if (installed === "installed") await retireVerifiedReceipt(held);
          else if (installed === "invalid") held.state = "held";
          state.notice = held.notice;
        }
        state.preview = null;
        previewScope = null;
      } finally {
        state.saving = false;
        emit();
      }
    },
    async check(requestId?: string) {
      if (disposed || !deps.canWrite()) return;
      const scope = observeScope();
      let ids: string[];
      try {
        ids = requestId
          ? [requestId]
          : state.activeRequestId
            ? [state.activeRequestId]
            : [];
      } catch {
        return;
      }
      for (const id of ids) {
        let identity: SmithEditIdentity | null;
        try {
          identity = store(scope).read(id);
        } catch {
          const failed = entry(id, scope);
          if (failed)
            failed.notice =
              "Saved edit metadata could not be verified. Its bytes were kept.";
          continue;
        }
        if (!identity) continue;
        let held = entry(id, scope);
        if (!held) {
          held = {
            identity,
            request: null,
            receipt: null,
            state:
              identity.retirement === "correlated-confirmation"
                ? "confirmed"
                : identity.retirement === "correlated-refusal"
                  ? "refused"
                  : identity.retired
                    ? "not-sent"
                    : "held",
            checking: false,
            notice: "Checking the saved original only; no edit will be sent.",
          };
          state.entries.push(held);
        }
        if (identity.retired && identity.retirement === "verified-not-sent") {
          held.identity = identity;
          held.state = "not-sent";
          held.notice =
            "The request was proven not sent. Review again before starting a new edit.";
          continue;
        }
        if (held.checking) continue;
        held.checking = true;
        emit();
        const ticket = generation;
        try {
          const raw = await deps.readOriginal(id);
          if (current(ticket, scope)) {
            const installed = await installReceipt(held, raw);
            if (installed === "installed") await retireVerifiedReceipt(held);
          }
        } catch {
          if (!disposed && held.state === "held")
            held.notice =
              "The original receipt could not be read. Its UUID remains held; check it again without resending.";
        } finally {
          held.checking = false;
          emit();
        }
      }
    },
    async recover() {
      if (disposed) return;
      const scope = observeScope();
      let identities: SmithEditIdentity[];
      try {
        identities = store(scope).list();
      } catch {
        state.notice =
          "Saved Smith edit metadata could not be verified. No request was sent.";
        emit();
        return;
      }
      for (const identity of identities) {
        if (!entry(identity.requestId, scope)) {
          state.entries.push({
            identity,
            request: null,
            receipt: null,
            state:
              identity.retirement === "correlated-confirmation"
                ? "confirmed"
                : identity.retirement === "correlated-refusal"
                  ? "refused"
                  : identity.retired
                    ? "not-sent"
                    : "held",
            checking: false,
            notice: identity.retired
              ? `A ${identity.retirement ?? "settlement"} outcome was saved. Reviewing its original only.`
              : "Checking the saved original only; no edit will be sent.",
          });
        }
      }
      emit();
      for (const identity of identities)
        if (!identity.retired || identity.retirement !== "verified-not-sent")
          await client.check(identity.requestId);
    },
    dispose() {
      disposed = true;
      generation++;
      listeners.clear();
    },
  };
  return client;
}

export type SmithConfigEditClient = ReturnType<
  typeof createSmithConfigEditClient
>;
