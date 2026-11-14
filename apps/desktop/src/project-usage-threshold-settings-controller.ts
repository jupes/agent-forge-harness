import { servedStatically } from "../../../docs/js/hearth-read";
import {
  createOperatorClient,
  launchSettled,
  NotSent,
  type OperatorClient,
} from "../../../docs/js/operator";
import { workspaceKey } from "../../../scripts/projects/scope";
import type { ProjectsHome } from "../../../types/project-summary";
import { ProjectUsageThresholdSettingsOwner } from "./project-usage-threshold-settings-client";
export interface UsageSettingsContext {
  connected: boolean;
  writesAllowed: boolean;
  home: ProjectsHome | null;
  homeCurrent: boolean;
  projectId: string | null;
  workspace: string | null;
  routeKey: string;
  active: boolean;
}
export interface UsageSettingsControllerDeps {
  current(): UsageSettingsContext;
  client?(
    canRead: () => boolean,
    canWrite: () => boolean,
  ): Pick<OperatorClient, "read" | "post">;
  changed?(): void;
}
const unavailable = "The current usage settings scope could not be verified.";
class GuardedUsageOwner extends ProjectUsageThresholdSettingsOwner {
  constructor(
    private readonly grant: () => boolean,
    binding: ConstructorParameters<
      typeof ProjectUsageThresholdSettingsOwner
    >[0],
    deps: ConstructorParameters<typeof ProjectUsageThresholdSettingsOwner>[1],
  ) {
    super(binding, deps);
  }
  override async reserve(
    ...args: Parameters<ProjectUsageThresholdSettingsOwner["reserve"]>
  ) {
    if (this.grant()) await super.reserve(...args);
  }
  override async retryReserveNotSent() {
    if (this.grant()) await super.retryReserveNotSent();
  }
  override confirmReview(
    ...args: Parameters<ProjectUsageThresholdSettingsOwner["confirmReview"]>
  ) {
    return this.grant() ? super.confirmReview(...args) : null;
  }
  override async apply(
    ...args: Parameters<ProjectUsageThresholdSettingsOwner["apply"]>
  ) {
    if (this.grant()) await super.apply(...args);
  }
  override async discard(
    ...args: Parameters<ProjectUsageThresholdSettingsOwner["discard"]>
  ) {
    if (this.grant()) await super.discard(...args);
  }
}
/** Retains live owners; connection continuity is never inferred from a fresh catalog. */
export function createUsageThresholdSettingsController(
  deps: UsageSettingsControllerDeps,
) {
  const entries = new Map<
    string,
    { projectId: string; workspace: string; owner: GuardedUsageOwner }
  >();
  let previous = deps.current(),
    epoch = 0,
    closed = false,
    connectedOnce = previous.connected,
    retired = false,
    revoking = false;
  const client =
    deps.client ??
    ((read, write) =>
      createOperatorClient(
        async (url, init) => {
          if (!(init?.method === "POST" ? write() : read()))
            throw new NotSent(unavailable);
          return fetch(url, init);
        },
        {
          staticCopy: servedStatically(),
          ready: launchSettled,
          postProblem: () => (write() ? null : unavailable),
        },
      ));
  const sync = () => {
    const next = deps.current();
    if (revoking) return next;
    if (connectedOnce && !next.connected) retired = true;
    connectedOnce ||= next.connected;
    const changed =
      next.connected !== previous.connected ||
      next.writesAllowed !== previous.writesAllowed ||
      next.home !== previous.home ||
      next.homeCurrent !== previous.homeCurrent ||
      next.projectId !== previous.projectId ||
      next.workspace !== previous.workspace ||
      next.routeKey !== previous.routeKey ||
      next.active !== previous.active;
    previous = next;
    if (changed) {
      epoch++;
      revoking = true;
      try {
        for (const entry of entries.values()) entry.owner.invalidateContext();
      } finally {
        revoking = false;
      }
    }
    return next;
  };
  const access = (
    entry: { projectId: string; workspace: string },
    write: boolean,
  ) => {
    const current = sync();
    return (
      !closed &&
      !retired &&
      !revoking &&
      current.connected &&
      current.active &&
      current.projectId === entry.projectId &&
      current.workspace !== null &&
      workspaceKey(current.workspace) === entry.workspace &&
      (!write || current.writesAllowed)
    );
  };
  const select = (
    projectId: string,
    workspace: string,
  ): GuardedUsageOwner | null => {
    const current = sync(),
      canonical = workspaceKey(workspace),
      key = JSON.stringify([projectId, canonical]);
    const retained = entries.get(key);
    if (retained) return retained.owner;
    const projects = current.home?.catalog.projects;
    if (
      closed ||
      retired ||
      revoking ||
      !current.connected ||
      !current.homeCurrent ||
      !projects ||
      projects.length > 32 ||
      new Set(projects.map((project) => project.id)).size !== projects.length ||
      projects.filter(
        (project) =>
          project.id === projectId &&
          project.workspaces.some(
            (scope) => workspaceKey(scope.root) === canonical,
          ),
      ).length !== 1 ||
      entries.size >= 64 ||
      current.workspace === null ||
      workspaceKey(current.workspace) !== canonical
    )
      return null;
    let entry: {
      projectId: string;
      workspace: string;
      owner: GuardedUsageOwner;
    };
    const transport = () => {
      const mine = epoch;
      const check = (write: boolean) => access(entry, write) && epoch === mine;
      return client(
        () => check(false),
        () => check(true),
      );
    };
    const owner = new GuardedUsageOwner(
      () => access(entry, true),
      { projectId, workspace: canonical },
      {
        read: (url, init, limits) => transport().read(url, init, limits),
        post: (url, body, limits) => transport().post(url, body, limits),
      },
    );
    entry = { projectId, workspace: canonical, owner };
    entries.set(key, entry);
    let terminal = "";
    owner.subscribe((value) => {
      const receipt = value.lastTerminal;
      if (!receipt) return;
      const identity = JSON.stringify([
        receipt.original.requestId,
        receipt.originalHash,
        receipt.phase,
      ]);
      if (terminal === identity) return;
      terminal = identity;
      if (receipt.phase === "applied") deps.changed?.();
    });
    return owner;
  };
  return {
    select,
    sync,
    retained: (projectId: string) =>
      [...entries.values()].filter((entry) => entry.projectId === projectId),
    canWrite: (owner: ProjectUsageThresholdSettingsOwner) => {
      const entry = [...entries.values()].find(
        (entry) => entry.owner === owner,
      );
      return !!entry && access(entry, true);
    },
    notice: () =>
      retired
        ? "The usage settings connection changed. Retained originals are read-only because private-home continuity cannot be verified after reconnect."
        : "",
    close() {
      if (closed) return;
      closed = true;
      epoch++;
      for (const entry of entries.values()) entry.owner.dispose();
    },
  };
}
