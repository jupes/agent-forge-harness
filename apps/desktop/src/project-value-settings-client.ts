import { NotSent, type OperatorPost } from "../../../docs/js/operator";
import { validatedGeneralCatalog } from "./project-general-settings-client";

export interface ProjectValue<T> {
  catalog: { revision: number; value: T } | null;
  draft: T | null;
  needsReview: boolean;
  checked: boolean;
  message: string;
}
export interface ProjectValueSnapshot<T> {
  projects: Record<string, ProjectValue<T>>;
  busy: string | null;
}
export interface ProjectValueSpec<T> {
  key: string;
  label: string;
  parse(value: unknown): T;
}
export interface ProjectValueDependencies {
  read(): Promise<unknown>;
  post: OperatorPost;
  refreshHome?(): Promise<unknown>;
  readPending?(): Record<string, number>;
  writePending?(value: Record<string, number>): void;
}
const equal = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** Revision-safe complete-value settings writes. Pending storage contains metadata, never bodies. */
export class ProjectValueSettingsOwner<T> {
  private value: ProjectValueSnapshot<T> = { projects: {}, busy: null };
  private listeners = new Set<(value: ProjectValueSnapshot<T>) => void>();
  private pending: Record<string, number> = {};
  private storageError = false;
  constructor(
    private spec: ProjectValueSpec<T>,
    private deps: ProjectValueDependencies,
  ) {
    try {
      this.pending = deps.readPending?.() ?? {};
    } catch {
      this.storageError = true;
    }
  }
  snapshot = () => this.value;
  subscribe = (listener: (value: ProjectValueSnapshot<T>) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    this.value = { ...this.value };
    for (const listener of this.listeners) listener(this.value);
  }
  private update(id: string, change: Partial<ProjectValue<T>>) {
    this.value.projects = {
      ...this.value.projects,
      [id]: {
        ...(this.value.projects[id] ?? {
          catalog: null,
          draft: null,
          needsReview: false,
          checked: false,
          message: "",
        }),
        ...change,
      },
    };
    this.emit();
  }
  private project(raw: unknown, id: string) {
    const general = validatedGeneralCatalog(raw, id);
    const rows = (raw as { projects: Array<{ id: string }> }).projects;
    const row = rows.find((item) => item.id === id);
    if (!row) throw Error("Project unavailable");
    return {
      revision: general.revision,
      value: this.spec.parse(Reflect.get(row, this.spec.key)),
    };
  }
  private persist(value: Record<string, number>) {
    this.deps.writePending?.(value);
    this.pending = value;
  }
  adopt(id: string, raw: unknown) {
    try {
      const catalog = this.project(raw, id),
        prior = this.value.projects[id];
      if (prior?.catalog && catalog.revision < prior.catalog.revision) return;
      const changed =
        prior?.draft !== null &&
        prior?.draft !== undefined &&
        prior.catalog &&
        !equal(prior.catalog, catalog);
      this.update(id, {
        catalog,
        ...(changed || Object.hasOwn(this.pending, id) || this.storageError
          ? {
              needsReview: true,
              checked: false,
              message: this.storageError
                ? "Pending settings could not be restored. Restore browser storage and reload before saving."
                : "Check current settings and compare your draft before saving.",
            }
          : {}),
      });
    } catch {
      this.update(id, {
        needsReview: true,
        checked: false,
        message: `${this.spec.label} could not be verified. Refresh before saving.`,
      });
    }
  }
  edit(id: string, value: T) {
    if (this.value.busy) return;
    try {
      this.update(id, { draft: structuredClone(this.spec.parse(value)) });
    } catch {
      this.update(id, {
        message: `Choose valid ${this.spec.label.toLowerCase()}.`,
      });
    }
  }
  confirmReview(id: string) {
    if (
      !this.value.busy &&
      this.value.projects[id]?.checked &&
      !this.storageError
    )
      this.update(id, { needsReview: false, checked: false });
  }
  async review(id: string) {
    if (this.value.busy) return;
    this.value.busy = id;
    this.emit();
    try {
      const catalog = this.project(await this.deps.read(), id);
      if (catalog.revision < (this.value.projects[id]?.catalog?.revision ?? 0))
        throw Error("Stale catalog");
      const unknown = Object.hasOwn(this.pending, id);
      if (unknown && catalog.revision > this.pending[id]!) {
        const next = { ...this.pending };
        delete next[id];
        this.persist(next);
      }
      this.update(id, {
        catalog,
        needsReview: true,
        checked: true,
        message: unknown
          ? "Current values loaded. The earlier outcome remains unknown; this read proves current state only. Compare and review before a new save."
          : "Current values loaded. Compare and review before saving.",
      });
    } catch {
      this.update(id, {
        checked: false,
        message: `Current ${this.spec.label.toLowerCase()} could not be read. The original draft is retained.`,
      });
    } finally {
      this.value.busy = null;
      this.emit();
    }
  }
  async save(id: string) {
    const view = this.value.projects[id];
    if (
      this.value.busy ||
      this.storageError ||
      !view?.catalog ||
      view.draft === null ||
      view.needsReview
    )
      return;
    if (Object.keys(this.pending).some((key) => key !== id)) {
      this.update(id, {
        message:
          "Check the unresolved settings change in the other project before saving.",
      });
      return;
    }
    const original = structuredClone(view.catalog),
      intended = this.spec.parse(structuredClone(view.draft)),
      pendingBefore = { ...this.pending };
    this.value.busy = id;
    this.emit();
    let sent = false,
      accepted: number | null = null;
    try {
      const current = this.project(await this.deps.read(), id);
      if (
        current.revision <
        Math.max(
          original.revision,
          this.value.projects[id]?.catalog?.revision ?? 0,
        )
      ) {
        this.update(id, {
          needsReview: true,
          checked: false,
          message:
            "The settings read is older than the current catalog. Check current settings before saving.",
        });
        return;
      }
      if (!equal(current, original)) {
        this.update(id, {
          catalog: current,
          needsReview: true,
          checked: true,
          message:
            "The project changed. Compare current values and review before saving.",
        });
        return;
      }
      this.persist({ ...this.pending, [id]: original.revision });
      let response: Response;
      try {
        sent = true;
        response = await this.deps.post(
          `/__agent-forge/projects/${encodeURIComponent(id)}/settings/${this.spec.key}`,
          { expectedRevision: original.revision, [this.spec.key]: intended },
        );
      } catch (error) {
        if (error instanceof NotSent) {
          sent = false;
          this.persist(pendingBefore);
        }
        throw error;
      }
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408
      ) {
        sent = false;
        this.persist(pendingBefore);
        this.update(id, {
          needsReview: true,
          checked: false,
          message: `The change was refused (HTTP ${response.status}). Refresh and review before saving.`,
        });
        return;
      }
      if (!response.ok) throw Error("Unverified save response");
      const answer: unknown = await response.json();
      if (
        !answer ||
        typeof answer !== "object" ||
        !("ok" in answer) ||
        answer.ok !== true ||
        !("error" in answer) ||
        answer.error !== null ||
        !("data" in answer)
      )
        throw Error("Unverified save envelope");
      const receipt = this.project(answer.data, id);
      if (
        receipt.revision !== original.revision + 1 ||
        !equal(receipt.value, intended)
      )
        throw Error("Save receipt did not match this intent");
      accepted = receipt.revision;
      sent = false;
      const next = { ...this.pending };
      delete next[id];
      this.persist(next);
      this.update(id, {
        needsReview: true,
        checked: false,
        message: `Save accepted at revision ${accepted}. Reading current settings…`,
      });
      void this.deps.refreshHome?.().catch(() => undefined);
      try {
        const readback = this.project(await this.deps.read(), id);
        if (
          readback.revision <
          Math.max(accepted, this.value.projects[id]?.catalog?.revision ?? 0)
        )
          throw Error("Stale readback");
        const changed = !equal(readback.value, intended);
        this.update(id, {
          catalog: readback,
          draft: changed ? view.draft : null,
          needsReview: changed,
          checked: changed,
          message: `${this.spec.label} read at revision ${readback.revision}.${changed ? " Values changed after the save; compare and review again." : ""}`,
        });
      } catch {
        this.update(id, {
          needsReview: true,
          checked: false,
          message: `Save accepted at revision ${accepted}; current values are unavailable. Refresh before saving again.`,
        });
      }
    } catch {
      this.update(id, {
        needsReview:
          accepted !== null || sent || Object.hasOwn(pendingBefore, id),
        checked: false,
        message:
          accepted !== null
            ? `Save accepted at revision ${accepted}; recovery storage could not be updated. Refresh before saving again.`
            : sent
              ? "The outcome is unknown. Check current settings; no request will be repeated automatically."
              : "The request was not sent. The draft is retained.",
      });
    } finally {
      this.value.busy = null;
      this.emit();
    }
  }
}
