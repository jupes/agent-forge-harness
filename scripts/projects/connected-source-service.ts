import { randomUUID } from "node:crypto";
import type { ProjectCatalog } from "../../types/projects";
import { nativePhysicalPath } from "../native-realpath";
import {
  physicalSourceText,
  projectWorkspaceRef,
  sourceBinding,
  sourceWorkspace,
} from "./connected-source-common";
import type { WorkspaceSourceInstance } from "./connected-source-instance";
import {
  type ConnectedScopePreview,
  SOURCE_MAX_GRANTS,
  SOURCE_MAX_REQUESTS,
  SOURCE_MAX_WORKSPACES,
  type SourceAuthorization,
  type SourceAuthorizationReceipt,
  sourceAuthorizationReceiptSchema,
} from "./connected-source-protocol";
import {
  type ConnectedSource,
  type ConnectWorkspaceSource,
  ReplacedWorkspaceSource,
} from "./connected-source-transport";
import { ProjectStoreError } from "./store";

export type NativeSourcePicker = (
  signal: AbortSignal,
) => Promise<string | null>;
interface Grant {
  id: string;
  projectId: string;
  ref: string;
  binding: string;
  connection: ConnectedSource;
  abort: AbortController;
  retired: boolean;
}
interface AuthorizationOriginal {
  projectId: string;
  ref: string;
  hash: string;
  promise: Promise<SourceAuthorizationReceipt>;
  receipt: SourceAuthorizationReceipt | null;
  abort: AbortController;
  binding: string | null;
}

/** Private per-launch read grants. No root/port/token/executable comes from HTTP. */
export function createConnectedSources(options: {
  root: string;
  catalog: () => ProjectCatalog;
  own: WorkspaceSourceInstance;
  connect: ConnectWorkspaceSource;
  pick?: NativeSourcePicker;
}) {
  if (
    physicalSourceText(nativePhysicalPath(options.root)) !==
    physicalSourceText(options.own.root)
  )
    throw new ProjectStoreError(
      503,
      "The launched source root could not be verified.",
    );
  let active = true,
    pending: AuthorizationOriginal | null = null;
  const grants = new Map<string, Grant>(),
    requests = new Map<string, AuthorizationOriginal>(),
    epochs = new Map<string, number>();
  const key = (projectId: string, ref: string) => projectId + ":" + ref;
  const ready = () => {
    if (!active)
      throw new ProjectStoreError(
        503,
        "Workspace source authorization is closed.",
      );
  };
  function retireProject(projectId: string) {
    for (const grant of grants.values())
      if (grant.projectId === projectId) retire(grant);
    for (const request of requests.values())
      if (request.projectId === projectId && request.receipt === null)
        request.abort.abort();
  }
  const project = (projectId: string, revision?: number) => {
    ready();
    let catalog: ProjectCatalog;
    try {
      catalog = options.catalog();
    } catch {
      for (const grant of grants.values()) retire(grant);
      for (const request of requests.values())
        if (request.receipt === null) request.abort.abort();
      throw new ProjectStoreError(
        503,
        "The project catalog is unavailable; source grants were retired.",
      );
    }
    const found = catalog.projects.find((project) => project.id === projectId);
    if (!found || found.archived) retireProject(projectId);
    if (!found) throw new ProjectStoreError(404, "The project was not found.");
    if (found.archived)
      throw new ProjectStoreError(
        409,
        "Restore the project before changing or previewing its sources.",
      );
    for (const grant of grants.values())
      if (grant.projectId === projectId) {
        let matches = false;
        try {
          matches = grant.binding === sourceBinding(found, grant.ref);
        } catch {
          /* Removed workspace. */
        }
        if (!matches) retire(grant);
      }
    for (const request of requests.values())
      if (
        request.projectId === projectId &&
        request.receipt === null &&
        request.binding !== null
      ) {
        let matches = false;
        try {
          matches = request.binding === sourceBinding(found, request.ref);
        } catch {
          /* Removed workspace. */
        }
        if (!matches) request.abort.abort();
      }
    if (revision !== undefined && revision !== catalog.revision)
      throw new ProjectStoreError(
        409,
        "The project changed. Refresh before previewing or authorizing a source.",
      );
    if (found.workspaces.length > SOURCE_MAX_WORKSPACES)
      throw new ProjectStoreError(
        503,
        "This project exceeds the workspace source read limit.",
      );
    return { catalog, project: found };
  };
  const retire = (grant: Grant) => {
    grant.retired = true;
    grant.abort.abort();
    if (grants.get(key(grant.projectId, grant.ref)) === grant)
      grants.delete(key(grant.projectId, grant.ref));
  };
  const local = (root: string) =>
    physicalSourceText(root) === physicalSourceText(options.own.root);
  function list(projectId: string) {
    const current = project(projectId);
    return {
      projectId,
      catalogRevision: current.catalog.revision,
      controllerId: options.own.instanceId,
      nativeAuthorizationAvailable: options.pick !== undefined,
      remainingAuthorizationRequests: SOURCE_MAX_REQUESTS - requests.size,
      workspaces: current.project.workspaces.map((scope) => {
        const ref = projectWorkspaceRef(projectId, scope.root),
          grant = grants.get(key(projectId, ref));
        if (
          grant &&
          (grant.retired ||
            grant.binding !== sourceBinding(current.project, ref))
        )
          retire(grant);
        const owned = local(scope.root),
          currentGrant = grants.get(key(projectId, ref));
        return {
          workspaceRef: ref,
          root: scope.root,
          epicIds: scope.epicIds,
          authority: owned
            ? "served"
            : currentGrant
              ? "authorized"
              : "not-authorized",
          grantId: owned ? options.own.instanceId : (currentGrant?.id ?? null),
        };
      }),
    };
  }
  function original(projectId: string, requestId: string) {
    ready();
    const found = requests.get(requestId);
    if (!found || found.projectId !== projectId)
      throw new ProjectStoreError(
        404,
        "This authorization request was not found in the current Hearth launch.",
      );
    return (
      found.receipt ??
      sourceAuthorizationReceiptSchema.parse({
        requestId,
        projectId,
        workspaceRef: found.ref,
        state: "pending",
        grantId: null,
        reason:
          "This original source authorization is still pending. No new chooser was opened.",
      })
    );
  }
  function authorize(
    projectId: string,
    input: SourceAuthorization,
  ): Promise<SourceAuthorizationReceipt> {
    ready();
    const hash = JSON.stringify([projectId, input]),
      existing = requests.get(input.requestId);
    if (existing) {
      if (existing.hash !== hash)
        throw new ProjectStoreError(
          409,
          "This authorization UUID belongs to another original request.",
        );
      return existing.promise;
    }
    if (requests.size >= SOURCE_MAX_REQUESTS)
      throw new ProjectStoreError(
        409,
        "This launch has reached its retained authorization request limit. Check existing requests; reopen the app before new consent.",
      );
    let resolve!: (receipt: SourceAuthorizationReceipt) => void;
    const promise = new Promise<SourceAuthorizationReceipt>((done) => {
      resolve = done;
    });
    const entry: AuthorizationOriginal = {
      projectId,
      ref: input.workspaceRef,
      hash,
      promise,
      receipt: null,
      abort: new AbortController(),
      binding: null,
    };
    requests.set(input.requestId, entry);
    const receipt = (
      state: SourceAuthorizationReceipt["state"],
      grantId: string | null,
      reason: string | null,
    ) =>
      sourceAuthorizationReceiptSchema.parse({
        requestId: input.requestId,
        projectId,
        workspaceRef: input.workspaceRef,
        state,
        grantId,
        reason,
      });
    const epoch = epochs.get(key(projectId, input.workspaceRef)) ?? 0;
    const unchanged = () => {
      ready();
      if (
        entry.abort.signal.aborted ||
        (epochs.get(key(projectId, input.workspaceRef)) ?? 0) !== epoch
      )
        throw new ProjectStoreError(
          409,
          "This source authorization was retired.",
        );
    };
    async function perform() {
      unchanged();
      const initial = project(projectId, input.expectedRevision),
        scope = sourceWorkspace(initial.project, input.workspaceRef),
        binding = sourceBinding(initial.project, input.workspaceRef),
        expectedRoot = scope.root;
      entry.binding = binding;
      if (local(scope.root)) {
        const identity = await options.own.identity();
        unchanged();
        const fresh = project(projectId, input.expectedRevision);
        if (binding !== sourceBinding(fresh.project, input.workspaceRef))
          throw new ReplacedWorkspaceSource();
        return receipt("authorized", identity.instanceId, null);
      }
      if (!options.pick)
        throw new ProjectStoreError(
          503,
          "Native workspace source authorization is unavailable in this runtime.",
        );
      if (pending)
        throw new ProjectStoreError(
          409,
          "Another native source authorization is still pending. Check that original request first.",
        );
      if (
        grants.size >= SOURCE_MAX_GRANTS &&
        !grants.has(key(projectId, input.workspaceRef))
      )
        throw new ProjectStoreError(
          409,
          "This launch has reached its active source grant limit.",
        );
      pending = entry;
      try {
        const chosen = await options.pick(entry.abort.signal);
        unchanged();
        if (chosen === null)
          return receipt(
            "cancelled",
            null,
            "Native source authorization was cancelled; no new grant was added.",
          );
        physicalSourceText(chosen);
        const canonical = nativePhysicalPath(chosen);
        if (physicalSourceText(canonical) !== physicalSourceText(expectedRoot))
          throw new ProjectStoreError(
            409,
            "The selected folder is not this exact registered workspace.",
          );
        const beforeConnect = project(projectId, input.expectedRevision);
        if (
          binding !== sourceBinding(beforeConnect.project, input.workspaceRef)
        )
          throw new ReplacedWorkspaceSource();
        const connection = await options.connect(canonical, entry.abort.signal);
        unchanged();
        const current = project(projectId, input.expectedRevision);
        if (
          binding !== sourceBinding(current.project, input.workspaceRef) ||
          !connection.current()
        )
          throw new ReplacedWorkspaceSource();
        const id = randomUUID(),
          old = grants.get(key(projectId, input.workspaceRef));
        if (old) retire(old);
        grants.set(key(projectId, input.workspaceRef), {
          id,
          projectId,
          ref: input.workspaceRef,
          binding,
          connection,
          abort: new AbortController(),
          retired: false,
        });
        return receipt("authorized", id, null);
      } finally {
        if (pending === entry) pending = null;
      }
    }
    void perform().then(
      (value) => {
        entry.receipt = value;
        resolve(value);
      },
      (error) => {
        const reason =
          error instanceof ProjectStoreError
            ? error.message
            : "Workspace source authorization could not be verified. Check this original request before new consent.";
        const value = receipt("unavailable", null, reason);
        entry.receipt = value;
        resolve(value);
      },
    );
    return promise;
  }
  function revoke(projectId: string, ref: string, grantId: string) {
    ready();
    if (grantId === options.own.instanceId)
      throw new ProjectStoreError(
        409,
        "The launched workspace is the served source and has no revocable foreign grant.",
      );
    const id = key(projectId, ref),
      grant = grants.get(id);
    if (grant && grant.id !== grantId)
      throw new ProjectStoreError(
        409,
        "A newer source grant is active. Refresh before revoking it.",
      );
    const inFlight =
      pending?.projectId === projectId && pending.ref === ref ? pending : null;
    if (grant || inFlight) {
      epochs.set(id, (epochs.get(id) ?? 0) + 1);
      inFlight?.abort.abort();
      if (grant) retire(grant);
    }
    return { projectId, workspaceRef: ref, grantId, state: "revoked" as const };
  }
  async function preview(
    projectId: string,
    ref: string,
    revision: number,
    epicIds: readonly string[],
  ): Promise<ConnectedScopePreview & { grantId: string }> {
    const initial = project(projectId, revision),
      scope = sourceWorkspace(initial.project, ref);
    if (local(scope.root)) {
      const result = await options.own.preview({
        projectId,
        revision,
        epicIds,
        instanceId: options.own.instanceId,
      });
      ready();
      project(projectId, revision);
      if (result.workspaceRef !== ref)
        throw new ProjectStoreError(
          503,
          "The local source preview identity is unavailable.",
        );
      return { ...result, grantId: options.own.instanceId };
    }
    const id = key(projectId, ref),
      grant = grants.get(id);
    if (
      !grant ||
      grant.retired ||
      grant.binding !== sourceBinding(initial.project, ref)
    ) {
      if (grant) retire(grant);
      throw new ProjectStoreError(
        409,
        "Authorize this registered workspace source before previewing it.",
      );
    }
    try {
      const result = await grant.connection.preview({
        projectId,
        revision,
        epicIds,
        signal: grant.abort.signal,
      });
      ready();
      const current = project(projectId, revision);
      if (
        grant.retired ||
        grants.get(id) !== grant ||
        grant.binding !== sourceBinding(current.project, ref) ||
        !grant.connection.current() ||
        result.workspaceRef !== ref
      )
        throw new ReplacedWorkspaceSource();
      return { ...result, grantId: grant.id };
    } catch (error) {
      let bindingCurrent = false;
      try {
        const current = options
          .catalog()
          .projects.find((value) => value.id === projectId);
        bindingCurrent =
          !!current &&
          !current.archived &&
          sourceBinding(current, ref) === grant.binding;
      } catch {
        /* An unreadable registration never retains authority. */
      }
      if (
        !grant.retired &&
        active &&
        (error instanceof ReplacedWorkspaceSource ||
          !bindingCurrent ||
          !grant.connection.current())
      )
        retire(grant);
      throw error instanceof ProjectStoreError
        ? error
        : new ProjectStoreError(
            503,
            "The authorized workspace source is unavailable or incomplete.",
          );
    }
  }
  return {
    list,
    original,
    authorize,
    revoke,
    preview,
    deactivate() {
      active = false;
      pending?.abort.abort();
      for (const grant of grants.values()) retire(grant);
      options.own.deactivate();
    },
  };
}
export type ConnectedSources = ReturnType<typeof createConnectedSources>;
