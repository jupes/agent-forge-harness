import { z } from "zod";
import { NotSent } from "../../../docs/js/operator";
import {
  type AuthorizedSourcePreview,
  authorizedSourcePreviewSchema,
  type SourceList,
  sourceAuthorizationReceiptSchema,
  sourceAuthorizeSchema,
  sourceListSchema,
  sourceProjectIdSchema,
  sourceRefSchema,
} from "../../../scripts/projects/connected-source-protocol";
import {
  canonicalScopeSave,
  scopeSaveReceiptSchema,
  scopeSaveSchema,
} from "../../../scripts/projects/scope-settings-protocol";

const pendingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("authorize"),
      projectId: sourceProjectIdSchema,
      controllerId: z.uuid(),
      request: sourceAuthorizeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("save"),
      projectId: sourceProjectIdSchema,
      controllerId: z.uuid(),
      request: scopeSaveSchema,
      inputHash: sourceRefSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("revoke"),
      projectId: sourceProjectIdSchema,
      controllerId: z.uuid(),
      workspaceRef: sourceRefSchema,
      grantId: z.uuid(),
    })
    .strict(),
]);
type Pending = z.infer<typeof pendingSchema>;
export interface ScopeView {
  list: SourceList | null;
  drafts: Record<string, string[]>;
  epics: Record<string, AuthorizedSourcePreview["epics"]>;
  previews: Record<string, AuthorizedSourcePreview>;
  errors: Record<string, string>;
  pending: Pending | null;
  enabled: boolean;
  archived: boolean;
  expectedRevision: number | null;
  busy: boolean;
  notice: string;
  storageError: boolean;
}
interface Dependencies {
  read(path: string, signal?: AbortSignal): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  readPending(): unknown;
  writePending(value: Pending | null): void;
  refreshHome(): Promise<unknown>;
}
export function scopeAggregate(view: ScopeView): {
  count: number | null;
  reason: string;
} {
  const list = view.list;
  if (list && list.catalogRevision !== view.expectedRevision)
    return {
      count: null,
      reason: "The project catalog changed. Refresh current Scope sources.",
    };
  if (!list || !list.workspaces.length)
    return { count: null, reason: "Load every registered workspace source." };
  const proofs = list.workspaces.map((row) => view.previews[row.workspaceRef]);
  if (
    proofs.some(
      (proof, index) =>
        !proof ||
        proof.projectId !== list.projectId ||
        proof.catalogRevision !== list.catalogRevision ||
        proof.grantId !== list.workspaces[index]!.grantId ||
        JSON.stringify(proof.epicIds) !==
          JSON.stringify(
            [
              ...(view.drafts[list.workspaces[index]!.workspaceRef] ?? []),
            ].sort(),
          ),
    )
  )
    return {
      count: null,
      reason: "Every workspace needs a complete preview for these selections.",
    };
  if (
    new Set(proofs.map((proof) => proof!.instance.tracker.projectId)).size !==
    proofs.length
  )
    return {
      count: null,
      reason:
        "Multiple workspaces identify the same tracker. Resolve the duplicate source.",
    };
  return {
    count: proofs.reduce((sum, proof) => sum + proof!.scopeCount, 0),
    reason:
      "Fresh observations from each tracker; these reads are not an atomic global snapshot.",
  };
}
export class ProjectScopeOwner {
  private view: ScopeView = {
    list: null,
    drafts: {},
    epics: {},
    previews: {},
    errors: {},
    pending: null,
    enabled: false,
    archived: false,
    expectedRevision: null,
    busy: false,
    notice: "",
    storageError: false,
  };
  private listeners = new Set<(view: ScopeView) => void>();
  private active = true;
  private expectedRevision: number | null = null;
  private reads = new AbortController();
  constructor(
    readonly projectId: string,
    private deps: Dependencies,
  ) {
    sourceProjectIdSchema.parse(projectId);
    try {
      const raw = deps.readPending();
      if (raw !== null) {
        const pending = pendingSchema.parse(raw);
        if (pending.projectId !== projectId) throw Error();
        this.view.pending = pending;
        this.view.notice =
          "A prior action needs its exact result checked before another change.";
      }
    } catch {
      this.view.storageError = true;
      this.view.notice =
        "Pending Scope metadata could not be read. Restore it before making changes.";
    }
  }
  snapshot() {
    return structuredClone(this.view);
  }
  subscribe(listener: (view: ScopeView) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private emit() {
    if (this.active)
      for (const listener of this.listeners) listener(this.snapshot());
  }
  private base() {
    return "/projects/" + this.projectId + "/settings/sources";
  }
  private persist(pending: Pending | null) {
    this.deps.writePending(pending);
    this.view.pending = pending;
  }
  observeRevision(revision: number | null) {
    if (this.expectedRevision === revision) return;
    const previous = this.expectedRevision;
    this.expectedRevision = revision;
    this.view.expectedRevision = revision;
    if (previous !== null || this.view.list) {
      this.reads.abort();
      this.reads = new AbortController();
    }
    if (this.view.list && this.view.list.catalogRevision !== revision) {
      this.view.previews = {};
      this.view.notice =
        "The project catalog changed. Refresh sources and review Scope again.";
      this.emit();
    }
  }
  setArchived(archived: boolean) {
    if (this.view.archived === archived) return;
    this.view.archived = archived;
    if (archived) {
      this.reads.abort();
      this.reads = new AbortController();
      this.view.previews = {};
    }
    this.emit();
  }
  setEnabled(enabled: boolean) {
    if (this.view.enabled === enabled) return;
    this.view.enabled = enabled;
    if (!enabled) {
      this.reads.abort();
      this.reads = new AbortController();
      this.view.previews = {};
      this.view.notice =
        "Scope changes wait for a verified connection to this Hearth.";
    }
    this.emit();
  }
  dispose() {
    this.active = false;
    this.reads.abort();
    this.listeners.clear();
  }
  private async run(work: () => Promise<void>) {
    if (!this.active || this.view.busy) return;
    this.view.busy = true;
    this.emit();
    try {
      await work();
    } catch {
      if (this.active)
        this.view.notice = this.view.pending
          ? "The action result is unknown. Check this exact request; do not repeat the change."
          : "Scope data could not be verified. Refresh and review before changing it.";
    } finally {
      if (this.active) {
        this.view.busy = false;
        this.emit();
      }
    }
  }
  private async readList(reset: boolean) {
    const signal = this.reads.signal;
    const list = sourceListSchema.parse(
      await this.deps.read(this.base(), signal),
    );
    if (!this.active || signal.aborted) return;
    if (list.projectId !== this.projectId)
      throw Error("Wrong project source list");
    this.view.list = list;
    this.view.previews = {};
    this.view.errors = {};
    if (reset) {
      this.view.epics = {};
      this.view.drafts = Object.fromEntries(
        list.workspaces.map((row) => [row.workspaceRef, [...row.epicIds]]),
      );
    }
  }
  async load() {
    return this.run(async () => {
      await this.readList(true);
      if (!this.active) return;
      this.view.notice = this.view.pending
        ? "Check the retained action result before another change."
        : "Sources loaded. Explicitly authorize other running workspaces, then review every preview.";
    });
  }
  edit(ref: string, ids: string[]) {
    if (
      !this.canChange() ||
      !this.view.list?.workspaces.some((row) => row.workspaceRef === ref)
    )
      return;
    const valid = sourceAuthorizeSchema.shape.workspaceRef.safeParse(ref);
    if (!valid.success || new Set(ids).size !== ids.length || ids.length > 64)
      return;
    this.view.drafts[ref] = [...ids].sort();
    delete this.view.previews[ref];
    delete this.view.errors[ref];
    this.emit();
  }
  canChange() {
    return (
      this.active &&
      this.view.enabled &&
      !this.view.archived &&
      !this.view.busy &&
      !this.view.pending &&
      !this.view.storageError &&
      !!this.view.list &&
      this.view.list.catalogRevision === this.expectedRevision
    );
  }
  canSave() {
    return (
      this.canChange() &&
      scopeAggregate(this.view).count !== null &&
      this.view.list!.workspaces.every(
        (row) => (this.view.drafts[row.workspaceRef]?.length ?? 0) > 0,
      )
    );
  }
  private async previewOne(
    ref: string,
    choicesOnly: boolean,
    signal: AbortSignal,
  ) {
    const list = this.view.list!,
      row = list.workspaces.find((row) => row.workspaceRef === ref);
    if (!row) throw Error();
    const ids = choicesOnly ? [] : [...(this.view.drafts[ref] ?? [])].sort(),
      query = new URLSearchParams({ revision: String(list.catalogRevision) });
    for (const id of ids) query.append("epicId", id);
    try {
      const proof = authorizedSourcePreviewSchema.parse(
        await this.deps.read(
          this.base() + "/" + ref + "/preview?" + query,
          signal,
        ),
      );
      if (!this.active || signal.aborted) return;
      if (
        this.view.list !== list ||
        this.expectedRevision !== list.catalogRevision ||
        proof.projectId !== this.projectId ||
        proof.catalogRevision !== list.catalogRevision ||
        proof.workspaceRef !== ref ||
        proof.grantId !== row.grantId ||
        JSON.stringify(proof.epicIds) !== JSON.stringify(ids)
      )
        throw Error();
      this.view.epics[ref] = proof.epics;
      if (!choicesOnly) this.view.previews[ref] = proof;
      delete this.view.errors[ref];
    } catch {
      if (this.active && !signal.aborted) {
        delete this.view.previews[ref];
        this.view.errors[ref] =
          "This source is unavailable, unauthorized or changed. Refresh sources and review its epic choices.";
      }
    }
  }
  async preview(ref?: string, choicesOnly = false) {
    if (!this.canChange()) return;
    return this.run(async () => {
      const abort = new AbortController(),
        signal = AbortSignal.any([abort.signal, this.reads.signal]),
        timer = setTimeout(() => abort.abort(), 30000);
      this.view.previews = {};
      try {
        const refs = ref
          ? [ref]
          : this.view.list!.workspaces.map((row) => row.workspaceRef);
        let cursor = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, refs.length) }, async () => {
            for (;;) {
              if (signal.aborted) return;
              const current = refs[cursor++];
              if (!current) return;
              await this.previewOne(current, choicesOnly, signal);
            }
          }),
        );
        if (this.active)
          this.view.notice = signal.aborted
            ? "Preview deadline reached. Aggregate remains unknown."
            : scopeAggregate(this.view).reason;
      } finally {
        clearTimeout(timer);
        abort.abort();
      }
    });
  }
  async authorize(ref: string) {
    if (
      !this.canChange() ||
      !this.view.list!.nativeAuthorizationAvailable ||
      this.view.list!.remainingAuthorizationRequests === 0
    )
      return;
    const row = this.view.list!.workspaces.find(
      (row) => row.workspaceRef === ref,
    );
    if (!row || row.authority === "served") return;
    return this.run(async () => {
      const pending: Pending = {
        kind: "authorize",
        projectId: this.projectId,
        controllerId: this.view.list!.controllerId,
        request: {
          requestId: crypto.randomUUID(),
          workspaceRef: ref,
          expectedRevision: this.view.list!.catalogRevision,
        },
      };
      this.persist(pending);
      this.view.previews = {};
      this.emit();
      try {
        const result = await this.deps.post(
          this.base() + "/authorize",
          pending.request,
        );
        if (this.active && this.view.pending === pending)
          await this.authorizationResult(result, pending);
      } catch (error) {
        if (error instanceof NotSent && this.active) {
          this.persist(null);
          this.view.notice =
            "Authorization was not sent. No new dialog was requested.";
        } else throw error;
      }
    });
  }
  private async authorizationResult(
    raw: unknown,
    pending: Extract<Pending, { kind: "authorize" }>,
  ) {
    const receipt = sourceAuthorizationReceiptSchema.parse(raw);
    if (
      receipt.requestId !== pending.request.requestId ||
      receipt.projectId !== this.projectId ||
      receipt.workspaceRef !== pending.request.workspaceRef
    )
      throw Error();
    if (receipt.state === "pending") {
      this.view.notice = receipt.reason!;
      return;
    }
    this.persist(null);
    if (this.active)
      this.view.notice =
        receipt.state === "authorized"
          ? "Source authorized for this launch. Review fresh previews before saving Scope."
          : receipt.reason!;
    try {
      await this.readList(true);
    } catch {
      this.view.previews = {};
      this.view.notice +=
        " Source details are unavailable; the exact action result above is retained.";
    }
  }
  async revoke(ref: string) {
    if (!this.canChange()) return;
    const row = this.view.list!.workspaces.find(
      (row) => row.workspaceRef === ref,
    );
    if (!row || row.authority !== "authorized" || !row.grantId) return;
    const pending: Pending = {
      kind: "revoke",
      projectId: this.projectId,
      controllerId: this.view.list!.controllerId,
      workspaceRef: ref,
      grantId: row.grantId,
    };
    return this.run(async () => {
      this.persist(pending);
      this.view.previews = {};
      await this.sendRevocation(pending);
    });
  }
  private async sendRevocation(pending: Extract<Pending, { kind: "revoke" }>) {
    const result = z
      .object({
        projectId: sourceProjectIdSchema,
        workspaceRef: sourceRefSchema,
        grantId: z.uuid(),
        state: z.literal("revoked"),
      })
      .strict()
      .parse(
        await this.deps.post(
          this.base() + "/" + pending.workspaceRef + "/revoke",
          { grantId: pending.grantId },
        ),
      );
    if (!this.active) return;
    if (
      result.projectId !== this.projectId ||
      result.workspaceRef !== pending.workspaceRef ||
      result.grantId !== pending.grantId
    )
      throw Error();
    this.persist(null);
    await this.readList(true);
    if (this.active)
      this.view.notice =
        "Source grant revoked. All previews need review again.";
  }
  async save() {
    if (!this.canSave()) return;
    return this.run(async () => {
      const generation = this.reads;
      const list = this.view.list!,
        request = canonicalScopeSave(
          scopeSaveSchema.parse({
            requestId: crypto.randomUUID(),
            expectedRevision: list.catalogRevision,
            controllerId: list.controllerId,
            workspaces: list.workspaces.map((row) => {
              const proof = this.view.previews[row.workspaceRef]!;
              return {
                workspaceRef: row.workspaceRef,
                epicIds: proof.epicIds,
                grantId: proof.grantId,
                sourceInstanceId: proof.instance.instanceId,
                trackerId: proof.instance.tracker.projectId,
                scopeCount: proof.scopeCount,
                scopeHash: proof.scopeHash,
              };
            }),
          }),
        );
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(request)),
      );
      if (
        !this.active ||
        !this.view.enabled ||
        generation !== this.reads ||
        list !== this.view.list ||
        list.catalogRevision !== this.expectedRevision
      )
        return;
      const inputHash = Array.from(new Uint8Array(digest), (value) =>
          value.toString(16).padStart(2, "0"),
        ).join(""),
        pending: Pending = {
          kind: "save",
          projectId: this.projectId,
          controllerId: list.controllerId,
          request,
          inputHash,
        };
      this.persist(pending);
      this.view.previews = {};
      this.emit();
      try {
        const result = await this.deps.post(
          "/projects/" + this.projectId + "/settings/scope",
          request,
        );
        if (this.active && this.view.pending === pending)
          await this.saveResult(result, pending);
      } catch (error) {
        if (error instanceof NotSent && this.active) {
          this.persist(null);
          this.view.notice =
            "Scope Save was not sent. Review fresh previews before another Save.";
        } else throw error;
      }
    });
  }
  private async saveResult(
    raw: unknown,
    pending: Extract<Pending, { kind: "save" }>,
  ) {
    const receipt = scopeSaveReceiptSchema.parse(raw);
    if (
      receipt.requestId !== pending.request.requestId ||
      receipt.projectId !== this.projectId ||
      receipt.controllerId !== pending.controllerId ||
      receipt.inputHash !== pending.inputHash
    )
      throw Error();
    if (receipt.state === "pending") {
      this.view.notice = receipt.reason!;
      return;
    }
    this.persist(null);
    if (this.active) {
      this.view.notice =
        receipt.state === "saved"
          ? "Scope Save confirmed at catalog revision " +
            receipt.catalogRevision +
            ". Preview again for current counts."
          : receipt.reason +
            " Current Scope must be reviewed before another Save.";
      try {
        await this.readList(true);
      } catch {
        this.view.previews = {};
        this.view.notice +=
          " Source details are unavailable; the exact Save result above is retained.";
      }
      void this.deps.refreshHome().catch(() => undefined);
    }
  }
  async check() {
    const pending = this.view.pending;
    if (!pending || !this.view.enabled || this.view.storageError) return;
    return this.run(async () => {
      if (pending.kind === "revoke") {
        if (this.view.archived) {
          this.view.notice =
            "Unarchive the project before retrying its revocation action.";
          return;
        }
        await this.sendRevocation(pending);
        return;
      }
      const path =
        pending.kind === "authorize"
          ? this.base() + "/requests/" + pending.request.requestId
          : "/projects/" +
            this.projectId +
            "/settings/scope/requests/" +
            pending.request.requestId;
      const result = await this.deps.read(path, this.reads.signal);
      if (!this.active || this.view.pending !== pending) return;
      if (pending.kind === "authorize")
        await this.authorizationResult(result, pending);
      else await this.saveResult(result, pending);
    });
  }
  reviewNewController() {
    const pending = this.view.pending,
      list = this.view.list;
    if (
      !this.active ||
      this.view.busy ||
      !pending ||
      !list ||
      pending.controllerId === list.controllerId ||
      !this.view.enabled
    )
      return;
    try {
      this.persist(null);
      this.view.previews = {};
      this.view.notice =
        "The previous Hearth ended. Its original delivery remains unknown. Current Scope is loaded; review all sources and previews before a new change.";
      this.emit();
    } catch {
      this.view.notice =
        "Pending metadata could not be cleared. Changes remain held.";
      this.emit();
    }
  }
}
