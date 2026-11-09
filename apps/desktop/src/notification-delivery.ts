import type { ProjectNotifications } from "../../../scripts/projects/project-notifications-protocol";
import { projectInterruptionAllowed } from "../../../scripts/projects/project-notifications-protocol";
import { workspaceKey } from "../../../scripts/projects/scope";
import { projectShiftsPageSchema } from "../../../scripts/shifts/protocol";
import { managedShiftHref } from "./managed-shift-navigation";
import type { ProjectShiftScope } from "./project-shift-identities";
import { verifyProjectShiftReceipt } from "./project-shift-receipt";

export interface NotificationCatalog {
  projects: {
    id: string;
    name: string;
    archived: boolean;
    workspaces: { root: string }[];
    notifications?: ProjectNotifications | undefined;
  }[];
}

export interface NotificationControl {
  enabled: boolean;
  message: string;
  enable(): Promise<void>;
  pause(): void;
}
export interface HaltNotification {
  title: string;
  body: string;
  tag: string;
  open(): Promise<void>;
  beforeNative?(): Promise<boolean>;
}
/** Window-local observation only. No action client or mutation transport is accepted. */
export function createHaltNotificationDelivery(deps: {
  scope: ProjectShiftScope;
  current(): boolean;
  catalog(): Promise<NotificationCatalog>;
  read(path: string): Promise<unknown>;
  send(
    notification: HaltNotification,
  ): (() => void) | null | Promise<(() => void) | null>;
  navigate(href: string): void;
  status(message: string): void;
}) {
  let closed = false,
    baseline = true,
    epoch = 0;
  let running: Promise<void> | null = null,
    pending = false;
  const seen = new Set<string>(),
    closers = new Set<() => void>();
  const alive = () => !closed && deps.current();
  const base = `/projects/${encodeURIComponent(deps.scope.projectId)}/shifts`;
  const projectFrom = (catalog: NotificationCatalog) => {
    const matches = catalog.projects.filter(
      (p) => p.id === deps.scope.projectId,
    );
    const project = matches.length === 1 ? matches[0] : undefined;
    if (
      !project ||
      project.archived ||
      !project.workspaces.some(
        (w) => workspaceKey(w.root) === workspaceKey(deps.scope.workspace),
      )
    )
      throw Error("The current project is unavailable in this workspace.");
    return project;
  };
  const run = async () => {
    const generation = epoch;
    try {
      const page = projectShiftsPageSchema.parse(await deps.read(base));
      if (page.projectId !== deps.scope.projectId)
        throw Error("Foreign project shift page.");
      const receipts = await Promise.all(
        page.items.map((row) => verifyProjectShiftReceipt(deps.scope, row)),
      );
      const project = projectFrom(await deps.catalog());
      if (!alive() || generation !== epoch) return;
      for (const receipt of receipts) {
        const { intent, observation } = receipt;
        const key = `${intent.request.requestId}/${intent.requestHash}/${intent.shiftId}`;
        if (
          observation.phase !== "stopped" ||
          observation.reason !== "halted" ||
          !observation.actual ||
          seen.has(key)
        )
          continue;
        // Consume suppressed events too: enabling a preference never replays old halts.
        if (seen.size >= 1000) {
          deps.status(
            "Notification capacity reached. Pause and enable to establish a fresh baseline.",
          );
          return;
        }
        seen.add(key);
        if (
          baseline ||
          !projectInterruptionAllowed(
            {
              id: project.id,
              archived: project.archived,
              ...(project.notifications === undefined
                ? {}
                : { notifications: project.notifications }),
            },
            {
              projectId: intent.projectId,
              kind: "stopped-shift",
              reason: observation.reason,
            },
          )
        )
          continue;
        const open = async () => {
          if (!alive()) return;
          try {
            const fresh = await verifyProjectShiftReceipt(
              deps.scope,
              await deps.read(
                `${base}/requests/${encodeURIComponent(intent.request.requestId)}`,
              ),
              {
                requestId: intent.request.requestId,
                requestHash: intent.requestHash,
                shiftId: intent.shiftId,
              },
            );
            projectFrom(await deps.catalog());
            if (
              !alive() ||
              fresh.observation.phase !== "stopped" ||
              fresh.observation.reason !== "halted"
            )
              return;
            deps.navigate(
              managedShiftHref({
                projectId: intent.projectId,
                requestId: intent.request.requestId,
                sessionId: null,
              }),
            );
          } catch {
            if (alive())
              deps.status(
                "This notification target is unavailable. Open the project to check its current state.",
              );
          }
        };
        try {
          const handle = await deps.send({
            title: "Agent Forge · Shift halted",
            body: `${project.name}: a bounded shift halted. Open to inspect.`,
            tag: key,
            beforeNative: async () => {
              try {
                const fresh = await verifyProjectShiftReceipt(
                  deps.scope,
                  await deps.read(
                    `${base}/requests/${encodeURIComponent(intent.request.requestId)}`,
                  ),
                  {
                    requestId: intent.request.requestId,
                    requestHash: intent.requestHash,
                    shiftId: intent.shiftId,
                  },
                );
                const currentProject = projectFrom(await deps.catalog());
                return (
                  alive() &&
                  generation === epoch &&
                  fresh.observation.phase === "stopped" &&
                  fresh.observation.reason === "halted" &&
                  projectInterruptionAllowed(
                    {
                      id: currentProject.id,
                      archived: currentProject.archived,
                      ...(currentProject.notifications === undefined
                        ? {}
                        : { notifications: currentProject.notifications }),
                    },
                    {
                      projectId: intent.projectId,
                      kind: "stopped-shift",
                      reason: "halted",
                    },
                  )
                );
              } catch {
                return false;
              }
            },
            open,
          });
          if (handle) {
            if (alive() && generation === epoch) closers.add(handle);
            else handle();
          }
        } catch {
          deps.status(
            "Native notification delivery failed; display is unconfirmed. The shift remains in the project.",
          );
        }
      }
      baseline = false;
    } catch {
      if (alive() && generation === epoch) {
        baseline = true;
        deps.status(
          "Notifications are waiting for verified project data. No delivery was retried.",
        );
      }
    }
  };
  const refresh = (resync = false): Promise<void> => {
    if (!alive()) return Promise.resolve();
    if (resync) {
      baseline = true;
      epoch++;
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
  };
  return {
    refresh,
    dispose() {
      closed = true;
      epoch++;
      for (const close of closers) close();
      closers.clear();
    },
  };
}

/** Production WebView2 default native notification path; constructing is not proof of display. */
export function sendWebNotification(
  notification: HaltNotification,
  status: (message: string) => void,
): () => void {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    throw Error("Native notification permission unavailable.");
  const native = new Notification(notification.title, {
    body: notification.body,
    tag: notification.tag,
  });
  native.onshow = () =>
    status("The notification runtime reported a displayed shift notification.");
  native.onerror = () =>
    status(
      "Native notification display is unconfirmed. Check the project for the halted shift.",
    );
  native.onclick = () => {
    native.close();
    void notification.open();
  };
  status("Native notification requested. Windows may suppress its display.");
  return () => {
    native.onshow = null;
    native.onerror = null;
    native.onclick = null;
    native.close();
  };
}

/** Every raw transition retires old work permanently, including A -> B -> A. */
export function createNotificationEpoch() {
  let epoch = 0,
    key = "";
  return {
    adopt(next: string) {
      if (next !== key) {
        key = next;
        epoch++;
      }
    },
    invalidate() {
      epoch++;
    },
    capture() {
      const token = epoch;
      return () => token === epoch;
    },
  };
}
/** Bind raw sources before passive observer effects; no second ledger connection. */
export function bindNotificationSources(
  sources: {
    status(): string;
    onStatus(listener: () => void): () => void;
    onHash(listener: () => void): () => void;
  },
  invalidate: () => void,
) {
  let closed = false,
    status = sources.status();
  const stopStatus = sources.onStatus(() => {
    const next = sources.status();
    if (!closed && next !== status) {
      status = next;
      invalidate();
    }
  });
  const stopHash = sources.onHash(() => {
    if (!closed) invalidate();
  });
  return () => {
    closed = true;
    stopStatus();
    stopHash();
  };
}

/** A late permission answer cannot opt a replacement scope into interruptions. */
export async function requestNotificationPermission(
  native: {
    readonly permission: NotificationPermission;
    requestPermission(): Promise<NotificationPermission>;
  },
  current: () => boolean,
): Promise<NotificationPermission | null> {
  if (!current()) return null;
  const permission =
    native.permission === "default"
      ? await native.requestPermission()
      : native.permission;
  return current() ? permission : null;
}
