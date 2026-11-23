import { randomUUID } from "node:crypto";
import type { ProjectCatalog } from "../../types/projects";
import { issuesAndDepsFromExportRows } from "../beads-dashboard";
import { nativePhysicalPath } from "../native-realpath";
import type { CompleteTrackerReader } from "./complete-tracker-reader";
import {
  physicalSourceText,
  pinSourceRoot,
  projectWorkspaceRef,
} from "./connected-source-common";
import {
  SOURCE_RESPONSE_BYTES,
  sourceInstanceSchema,
  sourcePreviewSchema,
} from "./connected-source-protocol";
import { workspaceKey } from "./scope";
import { scopeMembershipProof } from "./scope-proof";
import { ProjectStoreError } from "./store";

/** One actual trusted launched root; neither catalog roots nor HTTP fields create it. */
export function createWorkspaceSourceInstance(options: {
  root: string;
  catalog: () => ProjectCatalog;
  complete: CompleteTrackerReader;
  now?: () => Date;
}) {
  const root = nativePhysicalPath(options.root),
    instanceId = randomUUID();
  const sameRoot = pinSourceRoot(root);
  let active = true;
  const ready = () => {
    if (active && !sameRoot()) active = false;
    if (!active)
      throw new ProjectStoreError(
        503,
        "The workspace source instance is closed.",
      );
  };
  async function identity() {
    ready();
    const data = await options.complete();
    ready();
    return sourceInstanceSchema.parse({
      version: 1,
      instanceId,
      root,
      pid: process.pid,
      tracker: data.identity,
    });
  }
  async function preview(input: {
    projectId: string;
    revision: number;
    epicIds: readonly string[];
    instanceId: string;
    trackerId?: string;
  }) {
    ready();
    if (input.instanceId !== instanceId)
      throw new ProjectStoreError(
        409,
        "The workspace Hearth changed. Authorize it again.",
      );
    const catalog = options.catalog(),
      project = catalog.projects.find(
        (project) => project.id === input.projectId,
      );
    if (!project)
      throw new ProjectStoreError(404, "The project was not found.");
    if (project.archived || catalog.revision !== input.revision)
      throw new ProjectStoreError(
        409,
        "Refresh the current project before previewing Scope.",
      );
    const scopes = project.workspaces.filter(
      (scope) => physicalSourceText(scope.root) === physicalSourceText(root),
    );
    if (scopes.length !== 1)
      throw new ProjectStoreError(
        409,
        "This Hearth does not serve that registered workspace.",
      );
    const projectFingerprint = JSON.stringify(project);
    const scope = scopes[0]!,
      sourceAsOf = (options.now?.() ?? new Date()).toISOString(),
      complete = await options.complete();
    ready();
    const fresh = options.catalog();
    if (
      fresh.revision !== catalog.revision ||
      JSON.stringify(
        fresh.projects.find((value) => value.id === project.id),
      ) !== projectFingerprint ||
      (input.trackerId !== undefined &&
        complete.identity.projectId !== input.trackerId)
    )
      throw new ProjectStoreError(
        409,
        "The source or project changed. Refresh Scope.",
      );
    const normalized = issuesAndDepsFromExportRows(complete.rows),
      proof = scopeMembershipProof(
        project.slug,
        workspaceKey(root),
        input.epicIds,
        normalized.issues,
      );
    if (!proof)
      throw new ProjectStoreError(
        409,
        "A selected epic is absent from the current source.",
      );
    const result = sourcePreviewSchema.parse({
      instance: {
        version: 1,
        instanceId,
        root,
        pid: process.pid,
        tracker: complete.identity,
      },
      projectId: project.id,
      catalogRevision: catalog.revision,
      workspaceRef: projectWorkspaceRef(project.id, scope.root),
      epicIds: [...input.epicIds].sort(),
      scopeCount: proof.count,
      scopeHash: proof.hash,
      sourceAsOf,
      epics: normalized.issues
        .filter((issue) => issue.type === "epic")
        .map((issue) => ({ id: issue.id, title: issue.title }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
    if (Buffer.byteLength(JSON.stringify(result)) > SOURCE_RESPONSE_BYTES)
      throw new ProjectStoreError(
        503,
        "The source preview exceeds its read limit.",
      );
    ready();
    return result;
  }
  return {
    root,
    instanceId,
    assertActive: ready,
    identity,
    preview,
    deactivate() {
      active = false;
    },
  };
}
export type WorkspaceSourceInstance = ReturnType<
  typeof createWorkspaceSourceInstance
>;
