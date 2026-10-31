import { projectGeneralSettingsSchema } from "../../../scripts/projects/project-general-protocol";
import { NotSent, type OperatorPost } from "../../../docs/js/operator";
import type { ProjectGeneralSettings } from "../../../scripts/projects/project-general-protocol";

export type GeneralDraft = {
  name: string;
  description: string;
  icon: string;
  color?: ProjectGeneralSettings["color"];
};

export interface GeneralProject {
  id: string;
  general: ProjectGeneralSettings;
  updatedAt: string;
}
export interface GeneralCatalog {
  revision: number;
  freshRead: boolean;
  project: GeneralProject;
}
export interface GeneralIntent {
  projectId: string;
  expectedRevision: number;
  original: ProjectGeneralSettings;
  submitted: ProjectGeneralSettings;
}
export interface GeneralSettingsSnapshot {
  catalog: GeneralCatalog | null;
  catalogs: Record<string, GeneralCatalog>;
  drafts: Record<string, GeneralDraft>;
  notices: Record<string, string>;
  priorNotices: Record<string, string[]>;
  projectionErrors: Record<string, string>;
  unresolved: GeneralIntent[];
  sendingProjectId: string | null;
  checkingProjectId: string | null;
  checkedProjectId: string | null;
  reviewedProjectId: string | null;
  reviewRequired: Record<string, boolean>;
}
export function generalCatalogForProject(snapshot: GeneralSettingsSnapshot, projectId: string | null): GeneralCatalog | null {
  return projectId ? snapshot.catalogs[projectId] ?? null : null;
}
interface Dependencies {
  read(): Promise<unknown>;
  post: OperatorPost;
  refreshHome?: () => Promise<unknown>;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function validatedGeneralCatalog(value: unknown, projectId: string, freshRead = false): GeneralCatalog {
  if (!record(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) ||
      typeof value.revision !== "number" || value.revision < 0 || !Array.isArray(value.projects) ||
      Object.hasOwn(value, "createOperations"))
    throw Error("The project catalog response was malformed.");
  const matches = value.projects.filter((item) => record(item) && item.id === projectId);
  if (matches.length !== 1) throw Error("The requested project is missing or ambiguous in the catalog.");
  const item = matches[0];
  if (!record(item) || typeof item.updatedAt !== "string" || Number.isNaN(Date.parse(item.updatedAt)) || new Date(item.updatedAt).toISOString() !== item.updatedAt)
    throw Error("The requested project record was malformed.");
  const general = projectGeneralSettingsSchema.parse({
    name: item.name, description: item.description, icon: item.icon,
    ...(item.color === undefined ? {} : { color: item.color }),
  });
  return { revision: value.revision, freshRead, project: { id: projectId, general, updatedAt: item.updatedAt } };
}

function sameGeneral(left: ProjectGeneralSettings, right: ProjectGeneralSettings) {
  return left.name === right.name && left.description === right.description &&
    left.icon === right.icon && left.color === right.color;
}
async function catalogFromResponse(response: Response, projectId: string): Promise<GeneralCatalog> {
  const envelope: unknown = await response.json().catch(() => null);
  if (!record(envelope) || envelope.ok !== true || envelope.error !== null) throw Error("The control plane returned an unverified answer.");
  return validatedGeneralCatalog(envelope.data, projectId);
}

export class ProjectGeneralSettingsOwner {
  private value: GeneralSettingsSnapshot = { catalog: null, catalogs: {}, drafts: {}, notices: {}, priorNotices: {}, projectionErrors: {}, unresolved: [], sendingProjectId: null, checkingProjectId: null, checkedProjectId: null, reviewedProjectId: null, reviewRequired: {} };
  private listeners = new Set<(snapshot: GeneralSettingsSnapshot) => void>();
  private operation = 0;
  constructor(private readonly deps: Dependencies) {}
  snapshot = (): GeneralSettingsSnapshot => this.value;
  subscribe = (listener: (snapshot: GeneralSettingsSnapshot) => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<GeneralSettingsSnapshot>) { this.value = { ...this.value, ...patch }; for (const listener of this.listeners) listener(this.value); }
  private notice(projectId: string, message: string) { this.update({ notices: { ...this.value.notices, [projectId]: message } }); }
  private markLastKnown(projectId: string) {
    const catalog = this.value.catalogs[projectId];
    if (catalog?.freshRead) {
      const lastKnown = { ...catalog, freshRead: false };
      this.update({ catalogs: { ...this.value.catalogs, [projectId]: lastKnown }, ...(this.value.catalog?.project.id === projectId ? { catalog: lastKnown } : {}) });
    }
  }
  adopt(projectId: string, value: unknown) {
    let catalog: GeneralCatalog;
    try { catalog = validatedGeneralCatalog(value, projectId); }
    catch (error) {
      this.update({ projectionErrors: { ...this.value.projectionErrors, [projectId]: error instanceof Error ? error.message : String(error) } });
      return;
    }
    const projectionErrors = { ...this.value.projectionErrors }; delete projectionErrors[projectId];
    this.update({ projectionErrors });
    const previous = this.value.catalogs[projectId];
    const stored = !previous || catalog.revision > previous.revision ? catalog : previous;
    const catalogs = { ...this.value.catalogs, [projectId]: stored };
    this.update({ catalogs, catalog: stored });
  }
  draft(projectId: string, original: ProjectGeneralSettings): GeneralDraft { return this.value.drafts[projectId] ?? original; }
  setDraft(projectId: string, draft: GeneralDraft) { this.update({ drafts: { ...this.value.drafts, [projectId]: draft }, ...(this.value.reviewRequired[projectId] ? { reviewedProjectId: null } : {}) }); }
  private fenced(catalog: GeneralCatalog): GeneralIntent[] { return this.value.unresolved.filter((intent) => intent.expectedRevision >= catalog.revision); }
  private async readCatalog(projectId: string, minimumRevision: number): Promise<GeneralCatalog> {
    const catalog = validatedGeneralCatalog(await this.deps.read(), projectId, true);
    if (catalog.revision < Math.max(minimumRevision, this.value.catalogs[projectId]?.revision ?? 0))
      throw Error("The catalog read is older than the revision already reviewed.");
    return catalog;
  }
  private publishRead(catalog: GeneralCatalog) {
    const previous = this.value.catalogs[catalog.project.id];
    if (previous && catalog.revision < previous.revision)
      throw Error("The catalog read is older than the revision already reviewed.");
    const catalogs = { ...this.value.catalogs, [catalog.project.id]: catalog };
    const projectionErrors = { ...this.value.projectionErrors };
    delete projectionErrors[catalog.project.id];
    this.update({ catalogs, projectionErrors, ...(!this.value.catalog || this.value.catalog.project.id === catalog.project.id ? { catalog } : {}) });
  }
  async review(projectId: string, minimumRevision = 0): Promise<void> {
    if (this.value.checkingProjectId || this.value.sendingProjectId) return;
    const blocked = this.value.unresolved.find((intent) => intent.projectId !== projectId);
    if (blocked) { this.notice(projectId, `Resolve the pending General update for project ${blocked.projectId} first.`); return; }
    const operation = ++this.operation;
    this.update({ checkingProjectId: projectId, checkedProjectId: null, reviewedProjectId: null });
    try {
      const catalog = await this.readCatalog(projectId, Math.max(minimumRevision, this.value.catalogs[projectId]?.revision ?? 0));
      if (operation !== this.operation) return;
      this.publishRead(catalog);
      const unresolved = this.fenced(catalog);
      const priorIntent = this.value.unresolved.find((intent) => intent.projectId === projectId);
      const fencedAny = this.value.unresolved.some((intent) => !unresolved.includes(intent));
      const priorNotices = fencedAny ? { ...this.value.priorNotices, [projectId]: [...(this.value.priorNotices[projectId] ?? []), "An earlier request's outcome remains unknown; this newer catalog revision fences any late commit. The current read proves state only."] } : this.value.priorNotices;
      this.update({ unresolved, priorNotices, checkingProjectId: null, checkedProjectId: projectId, reviewedProjectId: null });
      this.notice(projectId, fencedAny ? "The newer catalog revision prevents the earlier request from applying. Compare the current values with your draft below, then confirm your review." : priorIntent ? sameGeneral(catalog.project.general, priorIntent.submitted) ? "These values are present now. The catalog cannot confirm which request changed them; the earlier outcome remains unknown. Compare the current fields with your draft below, then confirm your review." : "The earlier outcome remains unknown. Compare the current catalog values with your draft below, then confirm your review." : "Current catalog values loaded. Compare them with your draft below, then confirm your review.");
    } catch (error) {
      if (operation !== this.operation) return;
      const prior = this.value.notices[projectId];
      this.update({
        checkingProjectId: null,
        ...(this.value.unresolved.some((intent) => intent.projectId === projectId) && prior
          ? { priorNotices: { ...this.value.priorNotices, [projectId]: [...(this.value.priorNotices[projectId] ?? []), prior] } }
          : {}),
      });
      this.notice(projectId, `Could not read current project settings: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  confirmReview(projectId: string) {
    if (this.value.checkedProjectId !== projectId || !this.value.reviewRequired[projectId]) return;
    const previous = this.value.notices[projectId];
    this.update({
      reviewedProjectId: projectId,
      ...(previous
        ? { priorNotices: { ...this.value.priorNotices, [projectId]: [...(this.value.priorNotices[projectId] ?? []), previous] } }
        : {}),
    });
    this.notice(projectId, "Current values reviewed. Saving will create a new revision-checked request; any earlier unknown request remains unconfirmed.");
  }
  async save(projectId: string, revision: number, original: ProjectGeneralSettings, rawDraft: GeneralDraft): Promise<void> {
    if (this.value.sendingProjectId || this.value.checkingProjectId) return;
    const foreign = this.value.unresolved.find((intent) => intent.projectId !== projectId);
    if (foreign) { this.notice(projectId, `Resolve the pending General update for project ${foreign.projectId} first.`); return; }
    if (this.value.unresolved.some((intent) => intent.projectId === projectId) && this.value.reviewedProjectId !== projectId) { this.notice(projectId, "Review the current catalog before submitting a new change."); return; }
    if (this.value.reviewRequired[projectId] && this.value.reviewedProjectId !== projectId) { this.notice(projectId, "Compare the current catalog values and review them before saving."); return; }
    const parsed = projectGeneralSettingsSchema.safeParse(rawDraft);
    if (!parsed.success) { this.notice(projectId, "Enter a valid name and icon before saving."); return; }
    const attempt: GeneralIntent = { projectId, expectedRevision: revision, original, submitted: parsed.data };
    const previous = this.value.notices[projectId];
    if (this.value.unresolved.some((intent) => intent.projectId === projectId) && previous)
      this.update({ priorNotices: { ...this.value.priorNotices, [projectId]: [...(this.value.priorNotices[projectId] ?? []), previous] } });
    const operation = ++this.operation;
    this.update({ sendingProjectId: projectId, checkedProjectId: null, reviewedProjectId: null });
    this.notice(projectId, "Checking the current project catalog…");
    let fresh: GeneralCatalog;
    try {
      fresh = await this.readCatalog(projectId, revision);
      if (operation !== this.operation) return;
      const unresolved = this.fenced(fresh);
      this.publishRead(fresh);
      this.update({ unresolved });
      if (fresh.revision !== revision || !sameGeneral(fresh.project.general, original)) {
        this.update({ sendingProjectId: null, checkedProjectId: projectId, reviewRequired: { ...this.value.reviewRequired, [projectId]: true } });
        this.notice(projectId, "The project changed since this form was reviewed. Compare the current values with your draft, then review again before saving."); return;
      }
    } catch (error) {
      if (operation !== this.operation) return;
      this.update({ sendingProjectId: null });
      this.notice(projectId, `Could not verify the project before saving: ${error instanceof Error ? error.message : String(error)}`); return;
    }
    this.notice(projectId, "Saving project settings…");
    let response: Response;
    try { response = await this.deps.post(`/__agent-forge/projects/${encodeURIComponent(projectId)}/settings/general`, { expectedRevision: revision, general: parsed.data }); }
    catch (error) {
      if (operation !== this.operation) return;
      if (error instanceof NotSent) {
        this.update({ sendingProjectId: null }); this.notice(projectId, `The request was not sent: ${error.message}. Your draft is still available to save.`); return;
      }
      this.unknown(attempt, `The request did not complete: ${error instanceof Error ? error.message : String(error)} The outcome is unknown. Check the current catalog before trying another change.`); return;
    }
    if (operation !== this.operation) return;
    if (response.status === 409) {
      this.update({ checkedProjectId: null, reviewRequired: { ...this.value.reviewRequired, [projectId]: true } });
      this.notice(projectId, "The project changed before this save. Compare the current catalog values with your draft before submitting again.");
      try {
        const current = await this.readCatalog(projectId, revision);
        if (operation !== this.operation) return;
        this.publishRead(current);
        this.update({ unresolved: this.fenced(current), checkedProjectId: projectId, sendingProjectId: null });
      } catch {
        if (operation !== this.operation) return;
        this.update({ sendingProjectId: null }); this.notice(projectId, "The project changed before this save. Its current catalog values could not be read; refresh and compare before submitting again.");
      }
      return;
    }
    if (response.status >= 500 || response.status === 408) { this.unknown(attempt, `The control plane returned HTTP ${response.status}; the outcome is unknown. Check the current catalog before trying another change.`); return; }
    if (!response.ok) { this.update({ sendingProjectId: null }); this.notice(projectId, `The control plane refused this change (HTTP ${response.status}). Review the current settings before submitting again.`); return; }
    let receipt: GeneralCatalog;
    try {
      receipt = await catalogFromResponse(response, projectId);
      if (receipt.revision !== revision + 1 || !sameGeneral(receipt.project.general, parsed.data)) throw Error("The success answer did not match the submitted project settings and revision.");
    } catch (error) { this.unknown(attempt, `The success answer could not be verified: ${error instanceof Error ? error.message : String(error)} Check the current catalog before trying another change.`); return; }
    void Promise.resolve().then(() => this.deps.refreshHome?.()).catch(() => undefined);
    this.notice(projectId, `The save was accepted at catalog revision ${receipt.revision}. Reading the current catalog…`);
    this.markLastKnown(projectId);
    try {
      const current = await this.readCatalog(projectId, receipt.revision);
      if (operation !== this.operation) return;
      const unresolved = this.fenced(current);
      this.publishRead(current);
      this.update({ unresolved, sendingProjectId: null });
      const drafts = { ...this.value.drafts }; delete drafts[projectId];
      const differs = !sameGeneral(current.project.general, parsed.data);
      this.update({ drafts, reviewRequired: { ...this.value.reviewRequired, [projectId]: differs }, checkedProjectId: differs ? projectId : null, reviewedProjectId: null });
      this.notice(projectId, differs ? `The save was accepted at catalog revision ${receipt.revision}; the newer catalog read at revision ${current.revision} shows different current values. Compare and review before another change.` : `Current project settings read at catalog revision ${current.revision}.`);
    } catch (error) {
      if (operation !== this.operation) return;
      this.update({ sendingProjectId: null, checkedProjectId: null, reviewRequired: { ...this.value.reviewRequired, [projectId]: true } });
      this.notice(projectId, `The save was accepted at catalog revision ${receipt.revision}, but current values are unavailable: ${error instanceof Error ? error.message : String(error)} Refresh before making another change.`);
    }
  }
  private unknown(intent: GeneralIntent, message: string) {
    this.markLastKnown(intent.projectId);
    this.update({ sendingProjectId: null, unresolved: [...this.value.unresolved, intent], checkedProjectId: null, reviewedProjectId: null, reviewRequired: { ...this.value.reviewRequired, [intent.projectId]: true } });
    this.notice(intent.projectId, message);
  }
}
