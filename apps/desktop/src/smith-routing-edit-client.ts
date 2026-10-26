import { z } from "zod";
import {
  canonicalSmithRoutingEditRequest,
  smithRoutingEditPreviewRequestSchema,
  smithRoutingEditPreviewSchema,
  smithRoutingEditReceiptSchema,
  smithRoutingEditRequestSchema,
} from "../../../scripts/config/smith-routing-edit-protocol";
import type {
  SmithRoutingEditChange,
  SmithRoutingEditPreview,
  SmithRoutingEditPreviewRequest,
  SmithRoutingEditReceipt,
  SmithRoutingEditRequest,
  SmithRoutingEditTarget,
} from "../../../types/smith-routing-edit";
import {
  isVerifiedSmithRoutingEditNotSent,
  type SmithRoutingEditPostResult,
} from "./smith-routing-edit-api";
import {
  type SmithRoutingEditIdentities,
  type SmithRoutingEditIdentity,
  smithRoutingEditInputHash,
} from "./smith-routing-edit-identities";

export type SmithRoutingEditEntry = {
  identity: SmithRoutingEditIdentity;
  request: SmithRoutingEditRequest | null;
  preview: SmithRoutingEditPreview | null;
  receipt: SmithRoutingEditReceipt | null;
  state: "held" | "confirmed" | "refused" | "not-sent";
  checking: boolean;
  notice: string;
};
export type SmithRoutingEditClientState = {
  target: SmithRoutingEditTarget;
  change: SmithRoutingEditChange | null;
  preview: SmithRoutingEditPreview | null;
  previewStale: boolean;
  previewing: boolean;
  saving: boolean;
  entries: SmithRoutingEditEntry[];
  notice: string;
};

const emptyState = (): SmithRoutingEditClientState => ({
  target: "workspace",
  change: null,
  preview: null,
  previewStale: false,
  previewing: false,
  saving: false,
  entries: [],
  notice: "",
});
function selectorFor(change: SmithRoutingEditChange): string {
  return change.kind === "default" ? "workflow.default_crew" : change.bench;
}
function unwrapEnvelope(raw: unknown): unknown {
  const checked = z
    .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
    .strict()
    .safeParse(raw);
  return checked.success ? checked.data.data : raw;
}
function retirementState(
  identity: SmithRoutingEditIdentity,
): SmithRoutingEditEntry["state"] | null {
  if (identity.retirement === "verified-not-sent") return "not-sent";
  if (identity.retirement === "confirmed") return "confirmed";
  if (identity.retirement === "refused") return "refused";
  return null;
}

/** App-root owner for one routing edit family; dialogs are views, never transaction owners. */
export function createSmithRoutingEditClient(deps: {
  identities(scope: string): SmithRoutingEditIdentities;
  scope(): string;
  canWrite(): boolean;
  requestId(): string;
  preview(input: SmithRoutingEditPreviewRequest): Promise<unknown>;
  post(
    request: SmithRoutingEditRequest,
    reservation: { scope: string; inputHash: string },
  ): Promise<SmithRoutingEditPostResult>;
  readOriginal(requestId: string): Promise<unknown>;
  changed?(): void;
}) {
  const state = emptyState(),
    listeners = new Set<() => void>();
  let disposed = false,
    generation = 0,
    draftGeneration = 0,
    observedScope = deps.scope();
  let previewSequence = 0,
    activePreviewOperation: number | null = null,
    saveSequence = 0,
    activeSaveOperation: number | null = null;
  let previewScope: string | null = null;
  const emit = () => {
    if (!disposed) {
      deps.changed?.();
      for (const listener of listeners) listener();
    }
  };
  const store = (scope = deps.scope()) => deps.identities(scope);
  const currentRead = (ticket: number, scope: string) => {
    const currentScope = observeScope();
    return !disposed && ticket === generation && currentScope === scope;
  };
  const current = (ticket: number, scope: string, draftTicket?: number) =>
    currentRead(ticket, scope) &&
    deps.canWrite() &&
    (draftTicket === undefined || draftTicket === draftGeneration);
  const observeScope = () => {
    let scope: string;
    try {
      scope = deps.scope();
    } catch {
      scope = "";
    }
    if (scope !== observedScope) {
      observedScope = scope;
      generation++;
      activePreviewOperation = null;
      activeSaveOperation = null;
      previewScope = null;
      state.preview = null;
      state.previewStale = false;
      state.previewing = false;
      state.saving = false;
      state.entries = state.entries.filter(
        (entry) => entry.identity.scope === scope,
      );
      state.notice =
        "Workspace changed. Review the routing edit again before saving.";
      emit();
    }
    return scope;
  };
  const findEntry = (id: string, scope: string) =>
    state.entries.find(
      (entry) =>
        entry.identity.requestId === id && entry.identity.scope === scope,
    );
  const ensureEntry = (
    identity: SmithRoutingEditIdentity,
    request: SmithRoutingEditRequest | null = null,
  ) => {
    let found = findEntry(identity.requestId, identity.scope);
    if (!found) {
      found = {
        identity,
        request,
        preview: null,
        receipt: null,
        state: retirementState(identity) ?? "held",
        checking: false,
        notice: "Checking the saved original only; no edit will be sent.",
      };
      state.entries.push(found);
    } else {
      found.identity = identity;
      if (request) found.request = request;
      if (identity.retirement)
        found.state = retirementState(identity) ?? found.state;
    }
    return found;
  };
  const hold = (
    identity: SmithRoutingEditIdentity,
    request: SmithRoutingEditRequest | null,
    notice: string,
  ) => {
    const entry = ensureEntry(identity, request);
    if (
      entry.state === "confirmed" ||
      entry.state === "refused" ||
      entry.state === "not-sent"
    )
      return;
    entry.state = "held";
    entry.notice = notice;
    emit();
  };

  async function installReceipt(
    identity: SmithRoutingEditIdentity,
    raw: unknown,
    expected: SmithRoutingEditRequest | null,
    ticket: number,
    scope: string,
    draftTicket?: number,
    readOnlyCheck = false,
  ): Promise<boolean> {
    const parsed = smithRoutingEditReceiptSchema.safeParse(unwrapEnvelope(raw));
    if (!parsed.success) return false;
    const receipt = parsed.data;
    let digest: string;
    try {
      digest = await smithRoutingEditInputHash(receipt.original);
    } catch {
      return false;
    }
    if (
      !(readOnlyCheck
        ? currentRead(ticket, scope)
        : current(ticket, scope, draftTicket))
    )
      return false;
    if (
      receipt.requestId !== identity.requestId ||
      receipt.original.requestId !== identity.requestId ||
      receipt.inputHash !== identity.inputHash ||
      digest !== identity.inputHash ||
      receipt.original.target !== identity.target ||
      selectorFor(receipt.original.change) !== identity.selector ||
      (expected !== null &&
        canonicalSmithRoutingEditRequest(receipt.original) !==
          canonicalSmithRoutingEditRequest(expected))
    )
      return false;
    const entry = ensureEntry(identity, expected);
    if (
      (entry.state === "confirmed" && receipt.result.phase !== "confirmed") ||
      (entry.state === "refused" && receipt.result.phase !== "refused") ||
      entry.state === "not-sent"
    )
      return false;
    if (
      identity.retired &&
      (identity.retirement === "confirmed" ||
        identity.retirement === "refused") &&
      receipt.result.phase !== identity.retirement
    )
      return false;
    entry.receipt = receipt;
    if (receipt.result.phase === "held") {
      entry.state = "held";
      entry.preview = receipt.result.preview;
      entry.notice =
        "The routing edit outcome is held. Check this original again; it will not be resent.";
      emit();
      return true;
    }
    const settlement = receipt.result.phase;
    if (
      identity.retired &&
      (identity.retirement === "confirmed" || identity.retirement === "refused")
    ) {
      if (settlement !== identity.retirement) return false;
      entry.state = settlement;
      entry.preview =
        receipt.result.phase === "confirmed" ? receipt.result.preview : null;
      entry.notice =
        settlement === "confirmed"
          ? "The saved original confirms this routing edit."
          : "The saved original confirms this routing edit was refused.";
      emit();
      return true;
    }
    try {
      const retired = await store(scope).retire(identity, settlement);
      if (
        !(readOnlyCheck
          ? currentRead(ticket, scope)
          : current(ticket, scope, draftTicket))
      )
        return false;
      entry.identity = retired;
      entry.state = settlement;
      entry.preview =
        receipt.result.phase === "confirmed" ? receipt.result.preview : null;
      entry.notice =
        settlement === "confirmed"
          ? "The reviewed routing edit was confirmed."
          : "The routing edit was refused; review a new request before trying again.";
      emit();
      return true;
    } catch {
      entry.state = "held";
      entry.notice =
        "The receipt was checked but settlement metadata could not be saved. Its UUID remains held.";
      emit();
      return false;
    }
  }

  const client = {
    get(): SmithRoutingEditClientState {
      const scope = observeScope();
      return structuredClone({
        ...state,
        entries: state.entries.filter(
          (entry) => entry.identity.scope === scope,
        ),
      });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setDraft(target: SmithRoutingEditTarget, change: SmithRoutingEditChange) {
      observeScope();
      const checked = smithRoutingEditPreviewRequestSchema.safeParse(
        structuredClone({ target, change }),
      );
      draftGeneration++;
      activePreviewOperation = null;
      state.preview = null;
      previewScope = null;
      state.previewStale = false;
      state.previewing = false;
      if (!checked.success) {
        state.change = null;
        state.notice = "The routing edit draft is invalid.";
      } else {
        state.target = checked.data.target;
        state.change = structuredClone(checked.data.change);
        state.notice = "";
      }
      emit();
    },
    async preview() {
      const scope = observeScope(),
        ticket = generation,
        draftTicket = draftGeneration,
        operation = ++previewSequence;
      if (!deps.canWrite() || !state.change) return;
      activePreviewOperation = operation;
      const input = structuredClone({
        target: state.target,
        change: state.change,
      });
      state.previewing = true;
      state.preview = null;
      previewScope = null;
      state.previewStale = false;
      emit();
      const ownsPreview = () =>
        activePreviewOperation === operation &&
        current(ticket, scope, draftTicket);
      try {
        const raw = await deps.preview(structuredClone(input));
        if (!ownsPreview()) return;
        const parsed = smithRoutingEditPreviewSchema.safeParse(
          unwrapEnvelope(raw),
        );
        if (
          !parsed.success ||
          parsed.data.target !== input.target ||
          JSON.stringify(parsed.data.review.change) !==
            JSON.stringify(input.change)
        ) {
          state.notice =
            "The routing edit preview did not match this exact draft.";
          return;
        }
        state.preview = parsed.data;
        previewScope = scope;
        state.notice = "Review the complete routing change before saving.";
      } catch {
        if (ownsPreview())
          state.notice = "The routing edit preview could not be verified.";
      } finally {
        if (activePreviewOperation === operation) {
          activePreviewOperation = null;
          state.previewing = false;
          emit();
        }
      }
    },
    async save() {
      const scope = observeScope();
      if (disposed || state.saving || !deps.canWrite() || !state.change) return;
      const draftTicket = draftGeneration,
        ticket = generation;
      const change = structuredClone(state.change),
        target = state.target,
        preview = state.preview;
      if (
        !preview ||
        state.previewStale ||
        previewScope !== scope ||
        preview.target !== target ||
        JSON.stringify(preview.review.change) !== JSON.stringify(change)
      ) {
        state.notice =
          "Create a current preview for this exact routing edit before saving.";
        emit();
        return;
      }
      let request: SmithRoutingEditRequest;
      try {
        request = smithRoutingEditRequestSchema.parse({
          requestId: deps.requestId(),
          target,
          change,
          expectedRevision: structuredClone(preview.expectedRevision),
        });
      } catch {
        state.notice = "A new routing edit UUID could not be verified.";
        emit();
        return;
      }
      state.saving = true;
      const operation = ++saveSequence;
      activeSaveOperation = operation;
      state.notice = "Saving the exact reviewed routing edit.";
      emit();
      let identity: SmithRoutingEditIdentity | null = null;
      try {
        const inputHash = await smithRoutingEditInputHash(request);
        if (!current(ticket, scope, draftTicket)) return;
        const reservation = await store(scope).reserve(
          request,
          selectorFor(change),
          inputHash,
        );
        identity = reservation.identity;
        const entry = current(ticket, scope, draftTicket)
          ? ensureEntry(identity, request)
          : null;
        if (!reservation.created) {
          if (entry) {
            entry.notice =
              "This UUID already has a saved original. Check its receipt; no request was resent.";
            state.notice = entry.notice;
            emit();
          }
          return;
        }
        if (!current(ticket, scope, draftTicket)) {
          try {
            const retired = await store(scope).retire(
              identity,
              "verified-not-sent",
            );
            if (current(ticket, scope, draftTicket)) {
              const currentEntry = entry ?? ensureEntry(identity, request);
              currentEntry.identity = retired;
              currentEntry.state = "not-sent";
              currentEntry.notice =
                "The draft or workspace changed before dispatch. The saved request was not sent; review again with a new UUID.";
              state.notice = currentEntry.notice;
              emit();
            }
          } catch {
            if (current(ticket, scope, draftTicket))
              hold(
                identity,
                request,
                "The draft or workspace changed before dispatch, but its no-send record could not be saved. The UUID remains held.",
              );
          }
          return;
        }
        const result = await deps.post(structuredClone(request), {
          scope,
          inputHash,
        });
        if (result.state === "not-sent") {
          if (
            !isVerifiedSmithRoutingEditNotSent(result, {
              requestId: request.requestId,
              scope,
              inputHash,
            })
          ) {
            if (current(ticket, scope, draftTicket))
              hold(
                identity,
                request,
                "The transport refusal did not match this exact routing edit. Its UUID remains held.",
              );
            return;
          }
          try {
            const retired = await store(scope).retire(
              identity,
              "verified-not-sent",
            );
            if (current(ticket, scope, draftTicket)) {
              const currentEntry = entry ?? ensureEntry(identity, request);
              currentEntry.identity = retired;
              currentEntry.state = "not-sent";
              currentEntry.notice = `${result.message} Review again before using a new UUID.`;
              state.notice = currentEntry.notice;
              emit();
            }
          } catch {
            if (current(ticket, scope, draftTicket))
              hold(
                identity,
                request,
                "The request was proven not sent, but its reservation could not be retired. Its UUID remains held.",
              );
          }
          return;
        }
        if (!current(ticket, scope, draftTicket)) {
          hold(
            identity,
            request,
            "Workspace changed while saving. Check the original UUID before starting another edit.",
          );
          return;
        }
        if (result.state === "unknown") {
          hold(
            identity,
            request,
            `${result.message} Check the saved original; it will not be resent.`,
          );
          return;
        }
        if (
          !(await installReceipt(
            identity,
            result.value,
            request,
            ticket,
            scope,
            draftTicket,
          ))
        )
          hold(
            identity,
            request,
            "The routing edit response could not be correlated. Its UUID remains held; check the original receipt.",
          );
      } catch {
        if (identity)
          hold(
            identity,
            request,
            "The routing edit outcome is unknown. Its UUID remains held; check the original receipt.",
          );
        else if (current(ticket, scope, draftTicket))
          state.notice =
            "The routing identity could not be saved and verified. No edit request was sent.";
      } finally {
        if (activeSaveOperation === operation) {
          activeSaveOperation = null;
          state.saving = false;
          emit();
        }
      }
    },
    async check(requestId: string) {
      const scope = observeScope();
      if (disposed || !scope) return;
      let identity: SmithRoutingEditIdentity | null;
      try {
        identity = store(scope).read(requestId);
      } catch {
        state.notice =
          "Saved routing edit identities could not be verified. No request was sent.";
        emit();
        return;
      }
      if (!identity) return;
      const entry = ensureEntry(identity);
      if (entry.state === "not-sent" || entry.checking) return;
      const ticket = generation;
      entry.checking = true;
      entry.notice =
        entry.state === "confirmed" || entry.state === "refused"
          ? "Reopening the saved original receipt only; no edit will be sent."
          : "Checking the original receipt only; no edit will be sent.";
      emit();
      try {
        const raw = await deps.readOriginal(identity.requestId);
        if (!currentRead(ticket, scope)) return;
        if (
          !(await installReceipt(
            identity,
            raw,
            entry.request,
            ticket,
            scope,
            undefined,
            true,
          ))
        ) {
          if (entry.state === "confirmed" || entry.state === "refused") {
            entry.notice =
              "The protected original did not match this saved terminal identity. Its recorded status remains unchanged.";
            emit();
          } else {
            hold(
              identity,
              entry.request,
              "The protected original did not match this saved routing identity. Its UUID remains held.",
            );
          }
        }
      } catch {
        if (currentRead(ticket, scope)) {
          if (entry.state === "held")
            entry.notice =
              "The protected original could not be read. Its UUID remains held; no request was resent.";
          else if (entry.state === "confirmed" || entry.state === "refused")
            entry.notice =
              "The saved original could not be reopened. Its recorded terminal status remains unchanged.";
          emit();
        }
      } finally {
        entry.checking = false;
        emit();
      }
    },
    async recover() {
      const scope = observeScope();
      if (disposed) return;
      let identities: SmithRoutingEditIdentity[];
      try {
        identities = store(scope).list();
      } catch {
        state.notice =
          "Saved routing edit identities could not be verified. No request was sent.";
        emit();
        return;
      }
      for (const identity of identities) ensureEntry(identity);
      emit();
      for (const identity of identities) {
        const terminal = retirementState(identity);
        if (terminal === "not-sent") continue;
        await client.check(identity.requestId);
      }
    },
    dispose() {
      disposed = true;
      generation++;
      activePreviewOperation = null;
      activeSaveOperation = null;
      listeners.clear();
    },
  };
  return client;
}
