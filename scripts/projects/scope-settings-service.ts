import { createHash } from "node:crypto";
import { projectWorkspaceRef } from "./connected-source-common";
import type { AuthorizedSourcePreview } from "./connected-source-protocol";
import { SOURCE_MAX_REQUESTS } from "./connected-source-protocol";
import type { ConnectedSources } from "./connected-source-service";
import {
  canonicalScopeSave,
  type ScopeSave,
  type ScopeSaveReceipt,
  scopeSaveReceiptSchema,
} from "./scope-settings-protocol";
import { createProjectStore, ProjectStoreError } from "./store";

/** Fresh observations from separate trackers are deliberately not an atomic global snapshot. */
export function createScopeSettings(home: string, sources: ConnectedSources) {
  const store = createProjectStore(home),
    originals = new Map<
      string,
      {
        projectId: string;
        hash: string;
        controllerId: string;
        receipt: ScopeSaveReceipt | null;
        promise: Promise<ScopeSaveReceipt>;
      }
    >();
  let active = true;
  const ready = () => {
    if (!active)
      throw new ProjectStoreError(
        503,
        "Scope saves are closed. Refresh the current Hearth before reviewing Scope.",
      );
  };
  const original = (projectId: string, requestId: string) => {
    ready();
    const entry = originals.get(requestId);
    if (!entry || entry.projectId !== projectId)
      throw new ProjectStoreError(
        404,
        "This Scope Save original is not retained by the current Hearth.",
      );
    return (
      entry.receipt ??
      scopeSaveReceiptSchema.parse({
        projectId,
        requestId,
        controllerId: entry.controllerId,
        inputHash: entry.hash,
        state: "pending",
        catalogRevision: null,
        reason: "This exact Scope Save is still pending. Do not repeat it.",
      })
    );
  };
  function save(projectId: string, raw: ScopeSave) {
    ready();
    const input = canonicalScopeSave(raw),
      hash = createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      found = originals.get(input.requestId);
    if (found) {
      if (found.hash !== hash || found.projectId !== projectId)
        throw new ProjectStoreError(
          409,
          "This Scope Save UUID is already bound to another request.",
        );
      return found.promise;
    }
    if (originals.size >= SOURCE_MAX_REQUESTS)
      throw new ProjectStoreError(
        409,
        "This launch has reached its retained Scope Save limit. Check originals before restarting.",
      );
    const initial = sources.list(projectId);
    if (initial.controllerId !== input.controllerId)
      throw new ProjectStoreError(
        409,
        "The receiving Hearth changed. Refresh sources and review Scope again.",
      );
    let resolve!: (value: ScopeSaveReceipt) => void;
    const promise = new Promise<ScopeSaveReceipt>((done) => {
        resolve = done;
      }),
      entry = {
        projectId,
        hash,
        controllerId: input.controllerId,
        receipt: null as ScopeSaveReceipt | null,
        promise,
      };
    originals.set(input.requestId, entry);
    const receipt = (
      state: "saved" | "unavailable",
      catalogRevision: number | null,
      reason: string | null,
    ) =>
      scopeSaveReceiptSchema.parse({
        projectId,
        requestId: input.requestId,
        controllerId: input.controllerId,
        inputHash: hash,
        state,
        catalogRevision,
        reason,
      });
    void perform().then(
      (value) => {
        entry.receipt = value;
        resolve(value);
      },
      (error) => {
        const value = receipt(
          "unavailable",
          null,
          error instanceof ProjectStoreError
            ? error.message
            : "Scope Save could not be confirmed. Read this original and the current catalog before any new Save.",
        );
        entry.receipt = value;
        resolve(value);
      },
    );
    async function perform() {
      ready();
      const catalog = store.read(),
        project = catalog.projects.find((value) => value.id === projectId);
      if (
        !project ||
        catalog.revision !== input.expectedRevision ||
        project.archived
      )
        throw new ProjectStoreError(
          409,
          "Refresh the active project and review Scope again.",
        );
      const byRef = new Map(
        input.workspaces.map((value) => [value.workspaceRef, value]),
      );
      if (
        project.workspaces.length !== byRef.size ||
        project.workspaces.some(
          (value) => !byRef.has(projectWorkspaceRef(projectId, value.root)),
        )
      )
        throw new ProjectStoreError(
          409,
          "Review exactly every registered workspace before saving Scope.",
        );
      const ordered = project.workspaces.map(
        (value) => byRef.get(projectWorkspaceRef(projectId, value.root))!,
      );
      let proofs: AuthorizedSourcePreview[] = [];
      const next = await store.updateScope(
        projectId,
        input.expectedRevision,
        ordered.map((value) => value.epicIds),
        async () => {
          const abort = new AbortController(),
            timer = setTimeout(() => abort.abort(), 30000);
          let cursor = 0;
          const observed: AuthorizedSourcePreview[] = new Array(ordered.length);
          try {
            const work = async () => {
              for (;;) {
                ready();
                if (abort.signal.aborted)
                  throw new ProjectStoreError(
                    503,
                    "The complete Scope review timed out. Aggregate remains unknown.",
                  );
                const index = cursor++;
                if (index >= ordered.length) return;
                const selected = ordered[index]!;
                const proof = await sources.preview(
                  projectId,
                  selected.workspaceRef,
                  input.expectedRevision,
                  selected.epicIds,
                  abort.signal,
                );
                if (
                  proof.grantId !== selected.grantId ||
                  proof.instance.instanceId !== selected.sourceInstanceId ||
                  proof.instance.tracker.projectId !== selected.trackerId ||
                  proof.scopeCount !== selected.scopeCount ||
                  proof.scopeHash !== selected.scopeHash
                )
                  throw new ProjectStoreError(
                    409,
                    "Workspace membership or authorization changed. Review fresh previews before saving Scope.",
                  );
                observed[index] = proof;
              }
            };
            await Promise.race([
              new Promise<never>((_resolve, reject) =>
                abort.signal.addEventListener(
                  "abort",
                  () =>
                    reject(
                      new ProjectStoreError(
                        503,
                        "The complete Scope review timed out. Aggregate remains unknown.",
                      ),
                    ),
                  { once: true },
                ),
              ),
              Promise.all(
                Array.from({ length: Math.min(4, ordered.length) }, work),
              ),
            ]);
            if (
              new Set(observed.map((value) => value.instance.tracker.projectId))
                .size !== observed.length
            )
              throw new ProjectStoreError(
                409,
                "Multiple workspaces identify the same tracker. Aggregate is unknown; resolve the duplicate source before saving.",
              );
            proofs = observed;
          } finally {
            clearTimeout(timer);
            abort.abort();
          }
        },
        () => {
          ready();
          for (const proof of proofs) sources.assertCurrent(projectId, proof);
        },
      );
      return receipt("saved", next.revision, null);
    }
    return promise;
  }
  return {
    save,
    original,
    deactivate() {
      active = false;
    },
  };
}
export type ScopeSettings = ReturnType<typeof createScopeSettings>;
