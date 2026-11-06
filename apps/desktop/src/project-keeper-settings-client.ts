import { NotSent, type OperatorPost } from "../../../docs/js/operator";
import { projectKeeperSettingsSchema } from "../../../scripts/projects/project-keeper-protocol";
import { validatedGeneralCatalog } from "./project-general-settings-client";

interface KeeperCatalog {
  revision: number;
  keeperSmith?: string | undefined;
}
interface KeeperProject {
  catalog: KeeperCatalog | null;
  draft: string | null;
  message: string;
  needsReview: boolean;
  checked: boolean;
}
interface Snapshot {
  projects: Record<string, KeeperProject>;
  busy: string | null;
}
interface Dependencies {
  read(): Promise<unknown>;
  post: OperatorPost;
  refreshHome?(): Promise<unknown>;
  readPending?(): Record<string, number>;
  writePending?(pending: Record<string, number>): void;
}
function projection(raw: unknown, id: string): KeeperCatalog {
  const general = validatedGeneralCatalog(raw, id);
  // The shared projection validates the envelope and unique project identity first.
  const rows = (
    raw as { projects: Array<{ id: string; keeperSmith?: unknown }> }
  ).projects;
  const item = rows.find((row) => row.id === id);
  const keeper = projectKeeperSettingsSchema.parse(
    item?.keeperSmith === undefined ? {} : { keeperSmith: item.keeperSmith },
  );
  return { revision: general.revision, ...keeper };
}
const empty = (): KeeperProject => ({
  catalog: null,
  draft: null,
  message: "",
  needsReview: false,
  checked: false,
});

/** Serializes settings writes, retaining uncertain intents across navigation and reload. */
export class ProjectKeeperSettingsOwner {
  private value: Snapshot = { projects: {}, busy: null };
  private listeners = new Set<(state: Snapshot) => void>();
  private pending: Record<string, number>;
  private recoveryError = "";
  constructor(private deps: Dependencies) {
    try {
      this.pending = deps.readPending?.() ?? {};
    } catch {
      this.pending = {};
      this.recoveryError =
        "Pending Keeper changes could not be restored. Restore browser storage, then reload before saving.";
    }
  }
  snapshot = () => this.value;
  subscribe = (listener: (state: Snapshot) => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private emit() {
    this.value = { ...this.value };
    for (const listener of this.listeners) listener(this.value);
  }
  private update(id: string, patch: Partial<KeeperProject>) {
    this.value.projects = {
      ...this.value.projects,
      [id]: { ...(this.value.projects[id] ?? empty()), ...patch },
    };
    this.emit();
  }
  private persist(next: Record<string, number>) {
    this.deps.writePending?.(next);
    this.pending = next;
  }
  adopt(id: string, raw: unknown) {
    try {
      const catalog = projection(raw, id),
        prior = this.value.projects[id];
      if (prior?.catalog && catalog.revision < prior.catalog.revision) return;
      const changed =
        prior?.catalog &&
        prior.draft !== null &&
        (catalog.revision !== prior.catalog.revision ||
          catalog.keeperSmith !== prior.catalog.keeperSmith);
      this.update(id, {
        catalog,
        ...(changed
          ? {
              needsReview: true,
              checked: false,
              message:
                "The project changed. Check and compare current Keeper values before saving.",
            }
          : {}),
        ...(Object.hasOwn(this.pending, id)
          ? {
              needsReview: true,
              message:
                "An earlier Keeper request's outcome is unknown. Check current settings before another save.",
            }
          : {}),
        ...(this.recoveryError
          ? { needsReview: true, message: this.recoveryError }
          : {}),
      });
    } catch {
      this.update(id, {
        message:
          "Keeper settings could not be verified. Refresh before saving.",
        needsReview: true,
        checked: false,
      });
    }
  }
  setDraft(id: string, draft: string) {
    if (!this.value.busy) this.update(id, { draft });
  }
  confirmReview(id: string) {
    if (this.value.projects[id]?.checked && !this.value.busy)
      this.update(id, { needsReview: false, checked: false });
  }
  async review(id: string) {
    if (this.value.busy) return;
    this.value.busy = id;
    this.emit();
    try {
      const catalog = projection(await this.deps.read(), id);
      const minimum = this.value.projects[id]?.catalog?.revision ?? 0;
      if (catalog.revision < minimum)
        throw Error("The catalog moved backwards.");
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
          ? "Current values loaded; the earlier outcome remains unknown. This read proves current state only. Compare your draft and review before a new save."
          : "Current values loaded. Compare your draft and review before saving.",
      });
    } catch (error) {
      this.update(id, {
        checked: false,
        message: `Could not read Keeper settings: ${String(error)}`,
      });
    } finally {
      this.value.busy = null;
      this.emit();
    }
  }
  async save(id: string) {
    const view = this.value.projects[id];
    if (this.recoveryError) {
      this.update(id, { message: this.recoveryError });
      return;
    }
    if (
      this.value.busy ||
      !view?.catalog ||
      view.needsReview ||
      view.draft === null
    )
      return;
    if (Object.keys(this.pending).some((key) => key !== id)) {
      this.update(id, {
        message:
          "Check the unresolved Keeper change in the other project before saving.",
      });
      return;
    }
    const keeper = projectKeeperSettingsSchema.safeParse(
      view.draft ? { keeperSmith: view.draft } : {},
    );
    if (!keeper.success) {
      this.update(id, { message: "Select a valid configured Smith." });
      return;
    }
    const original = view.catalog;
    this.value.busy = id;
    this.emit();
    let sent = false;
    let acceptedRevision: number | null = null;
    const pendingBefore = { ...this.pending };
    try {
      const current = projection(await this.deps.read(), id);
      if (
        current.revision !== original.revision ||
        current.keeperSmith !== original.keeperSmith
      ) {
        this.update(id, {
          catalog: current,
          needsReview: true,
          checked: true,
          message:
            "The project changed. Compare current values and review before saving.",
        });
        return;
      }
      // Persist before sending: if storage is unavailable, no write is attempted.
      this.persist({ ...this.pending, [id]: original.revision });
      let response: Response;
      try {
        sent = true;
        response = await this.deps.post(
          `/__agent-forge/projects/${encodeURIComponent(id)}/settings/keeper`,
          { expectedRevision: original.revision, keeper: keeper.data },
        );
      } catch (error) {
        if (error instanceof NotSent) {
          sent = false;
          this.persist(pendingBefore);
        }
        throw error;
      }
      if (
        response.status === 409 ||
        (response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408)
      ) {
        sent = false;
        this.persist(pendingBefore);
        this.update(id, {
          needsReview: true,
          checked: false,
          message:
            response.status === 409
              ? "The project changed before saving. Refresh, compare and review before a new save."
              : `The Keeper change was refused (HTTP ${response.status}). Refresh and review before saving.`,
        });
        return;
      }
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const envelope: unknown = await response.json();
      if (
        !envelope ||
        typeof envelope !== "object" ||
        !("ok" in envelope) ||
        envelope.ok !== true ||
        !("error" in envelope) ||
        envelope.error !== null ||
        !("data" in envelope)
      )
        throw Error("Unverified save answer");
      const receipt = projection(envelope.data, id);
      if (
        receipt.revision !== original.revision + 1 ||
        receipt.keeperSmith !== keeper.data.keeperSmith
      )
        throw Error(
          "Save answer did not match the intended revision and Keeper",
        );
      acceptedRevision = receipt.revision;
      sent = false;
      const next = { ...this.pending };
      delete next[id];
      this.persist(next);
      this.update(id, {
        message: `Save accepted at revision ${receipt.revision}. Reading current settings…`,
        needsReview: true,
        checked: false,
      });
      void this.deps.refreshHome?.().catch(() => undefined);
      try {
        const readback = projection(await this.deps.read(), id);
        if (
          readback.revision <
          Math.max(
            receipt.revision,
            this.value.projects[id]?.catalog?.revision ?? 0,
          )
        )
          throw Error("Stale readback");
        const changed = readback.keeperSmith !== keeper.data.keeperSmith;
        this.update(id, {
          catalog: readback,
          draft: changed ? view.draft : null,
          needsReview: changed,
          checked: changed,
          message: `Keeper settings read at revision ${readback.revision}.${changed ? " Values changed after the accepted save; compare and review again." : ""}`,
        });
      } catch {
        this.update(id, {
          needsReview: true,
          checked: false,
          message: `Save accepted at revision ${receipt.revision}; current values are unavailable. Refresh before another save.`,
        });
      }
    } catch (error) {
      this.update(id, {
        needsReview:
          acceptedRevision !== null ||
          sent ||
          Object.hasOwn(pendingBefore, id) ||
          view.needsReview,
        checked: false,
        message:
          acceptedRevision !== null
            ? `Save accepted at revision ${acceptedRevision}; recovery storage could not be updated. Refresh before another save.`
            : sent
              ? `The Keeper outcome is unknown: ${String(error)}. Check current settings; no request will be repeated automatically.`
              : `The Keeper request was not sent: ${String(error)}.`,
      });
    } finally {
      this.value.busy = null;
      this.emit();
    }
  }
}
