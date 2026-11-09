import {
  projectActivityDetailSchema,
  projectActivityPageSchema,
} from "../../../scripts/projects/activity-protocol";
import { projectBeadsPageSchema } from "../../../scripts/projects/beads-protocol";
import {
  type ProjectNotifications,
  projectInterruptionAllowed,
} from "../../../scripts/projects/project-notifications-protocol";
import { workspaceKey } from "../../../scripts/projects/scope";
import type { ProjectActivityEvent } from "../../../types/project-activity";
import { desktopHref } from "./navigation";
import type {
  HaltNotification,
  NotificationCatalog,
} from "./notification-delivery";
import {
  activityHref,
  activityPagePath,
  emptyActivityFilters,
} from "./project-activity-model";
import type { ProjectShiftScope } from "./project-shift-identities";

export const NOTIFICATION_ACTIVITY_KINDS = [
  "gate.ran",
  "council.run.finished",
  "bead.transitioned",
] as const;
const filters = {
  ...emptyActivityFilters(),
  kinds: [...NOTIFICATION_ACTIVITY_KINDS],
};
const metadata = (event: ProjectActivityEvent, key: string) =>
  event.metadata.find((item) => item.key === key)?.value;
export function notificationEventKind(
  event: ProjectActivityEvent,
): keyof ProjectNotifications | null {
  if (event.kind === "gate.ran" && metadata(event, "passed") === false)
    return "failed-gate";
  if (
    event.kind === "council.run.finished" &&
    ["pass", "fail", "unreadable"].includes(String(metadata(event, "outcome")))
  )
    return "council-verdict";
  if (
    event.kind === "bead.transitioned" &&
    event.beadId &&
    metadata(event, "to") === "proposed"
  )
    return "bead-approval";
  return null;
}
const labels = {
  "failed-gate": "Gate failed",
  "council-verdict": "Council verdict",
  "bead-approval": "Bead awaiting approval",
  "stopped-shift": "Shift halted",
};
/** Scoped source events are observations only; no writer or approval transport exists. */
export function createProjectEventNotifications(deps: {
  scope: ProjectShiftScope;
  current(): boolean;
  streamCursor(): number | null;
  catalog(): Promise<NotificationCatalog>;
  read(path: string): Promise<unknown>;
  send(
    notification: HaltNotification,
  ): (() => void) | null | Promise<(() => void) | null>;
  navigate(href: string): void;
  status(message: string): void;
}) {
  let cursor: number | null = null,
    epoch = 0,
    closed = false,
    pending = false;
  let running: Promise<void> | null = null;
  const handles = new Set<() => void>();
  const alive = () => !closed && deps.current();
  const base = `/projects/${encodeURIComponent(deps.scope.projectId)}`;
  const scoped = (value: { projectId: string; workspace: string }) => {
    if (
      value.projectId !== deps.scope.projectId ||
      workspaceKey(value.workspace) !== workspaceKey(deps.scope.workspace)
    )
      throw Error("Foreign notification source.");
  };
  const project = async () => {
    const catalog = await deps.catalog();
    const matches = catalog.projects.filter(
      (p) => p.id === deps.scope.projectId,
    );
    const found = matches.length === 1 ? matches[0] : undefined;
    if (
      !found ||
      found.archived ||
      !found.workspaces.some(
        (w) => workspaceKey(w.root) === workspaceKey(deps.scope.workspace),
      )
    )
      throw Error("Current project membership unavailable.");
    return found;
  };
  const approvalCurrent = async (event: ProjectActivityEvent) => {
    const page = projectBeadsPageSchema.parse(await deps.read(`${base}/beads`));
    scoped(page);
    return page.beads.some(
      (bead) =>
        bead.id === event.beadId &&
        bead.status !== "closed" &&
        bead.queue === "proposed",
    );
  };
  const baseline = () => {
    const next = deps.streamCursor();
    cursor =
      next !== null && Number.isSafeInteger(next) && next >= 0 ? next : null;
  };
  const run = async () => {
    const turn = epoch;
    if (cursor === null) {
      baseline();
      return;
    }
    let after = cursor;
    try {
      const events: ProjectActivityEvent[] = [],
        ulids = new Set<string>();
      for (let pageIndex = 0; pageIndex < 4; pageIndex++) {
        const path = activityPagePath(
          deps.scope.projectId,
          filters,
          after,
        ).slice("/__agent-forge".length);
        const page = projectActivityPageSchema.parse(await deps.read(path));
        scoped(page);
        if (
          page.after !== after ||
          JSON.stringify(page.filters) !== JSON.stringify(filters)
        )
          throw Error("Changed notification cursor or filters.");
        for (const event of page.events) {
          if (
            !NOTIFICATION_ACTIVITY_KINDS.some((kind) => kind === event.kind) ||
            ulids.has(event.ulid)
          )
            throw Error("Unexpected or duplicate event.");
          ulids.add(event.ulid);
          events.push(event);
        }
        after = page.nextAfter;
        if (!page.more) break;
        if (pageIndex === 3)
          throw Error("Notification backlog exceeds its bounded read.");
      }
      // Bound freshness checks and native interruptions before any publication.
      const selected = events.flatMap((event) => {
        const kind = notificationEventKind(event);
        return kind ? [{ event, kind }] : [];
      });
      if (selected.length > 32)
        throw Error("Notification batch exceeds 32 interruptions.");
      if (!alive() || turn !== epoch) return;
      cursor = after;
      for (const { event, kind } of selected) {
        const detail = projectActivityDetailSchema.parse(
          await deps.read(`${base}/activity/${event.id}`),
        );
        scoped(detail);
        if (JSON.stringify(detail.event) !== JSON.stringify(event))
          throw Error("Changed notification event before delivery.");
        if (kind === "bead-approval" && !(await approvalCurrent(event)))
          continue;
        const currentProject = await project();
        if (!alive() || turn !== epoch) return;
        if (
          !projectInterruptionAllowed(
            {
              id: currentProject.id,
              archived: currentProject.archived,
              ...(currentProject.notifications === undefined
                ? {}
                : { notifications: currentProject.notifications }),
            },
            { projectId: deps.scope.projectId, kind },
          )
        )
          continue;
        if (handles.size >= 1000) {
          deps.status(
            "Notification capacity reached. Pause and enable to establish a fresh baseline.",
          );
          return;
        }
        const open = async () => {
          if (!alive()) return;
          try {
            const detail = projectActivityDetailSchema.parse(
              await deps.read(`${base}/activity/${event.id}`),
            );
            scoped(detail);
            if (JSON.stringify(detail.event) !== JSON.stringify(event))
              throw Error("Changed notification event.");
            if (kind === "bead-approval" && !(await approvalCurrent(event)))
              throw Error("Approval is no longer pending.");
            await project();
            if (!alive()) return;
            deps.navigate(
              kind === "bead-approval"
                ? desktopHref({
                    projectId: deps.scope.projectId,
                    destination: "beads",
                    selection: { kind: "bead", id: event.beadId! },
                  })
                : activityHref(
                    deps.scope.projectId,
                    emptyActivityFilters(),
                    event.id,
                  ),
            );
          } catch {
            if (alive())
              deps.status(
                "This notification target is unavailable. Open the project to inspect its current state.",
              );
          }
        };
        try {
          const handle = await deps.send({
            title: `Agent Forge · ${labels[kind]}`,
            body: `${currentProject.name}: ${labels[kind]}. Open to inspect.`,
            tag: `${deps.scope.workspace}/${event.id}/${event.ulid}`,
            beforeNative: async () => {
              try {
                const source = projectActivityDetailSchema.parse(
                  await deps.read(`${base}/activity/${event.id}`),
                );
                scoped(source);
                if (
                  JSON.stringify(source.event) !== JSON.stringify(event) ||
                  (kind === "bead-approval" && !(await approvalCurrent(event)))
                )
                  return false;
                const currentProject = await project();
                return (
                  alive() &&
                  turn === epoch &&
                  projectInterruptionAllowed(
                    {
                      id: currentProject.id,
                      archived: currentProject.archived,
                      ...(currentProject.notifications === undefined
                        ? {}
                        : { notifications: currentProject.notifications }),
                    },
                    { projectId: deps.scope.projectId, kind },
                  )
                );
              } catch {
                return false;
              }
            },
            open,
          });
          if (handle) {
            if (alive() && turn === epoch) handles.add(handle);
            else handle();
          }
        } catch {
          deps.status(
            "Native notification display is unconfirmed. The source remains available in the project.",
          );
        }
      }
    } catch {
      if (alive() && turn === epoch) {
        cursor = null;
        deps.status(
          "Notification discovery is unavailable. Recovery establishes a new baseline; source records remain unchanged.",
        );
      }
    }
  };
  return {
    refresh(resync = false): Promise<void> {
      if (!alive()) return Promise.resolve();
      if (resync) {
        epoch++;
        baseline();
      }
      if (running) {
        pending = true;
        return running;
      }
      running = (async () => {
        do {
          pending = false;
          await run();
        } while (pending && alive());
      })().finally(() => {
        running = null;
      });
      return running;
    },
    dispose() {
      closed = true;
      epoch++;
      for (const close of handles) close();
      handles.clear();
    },
  };
}
