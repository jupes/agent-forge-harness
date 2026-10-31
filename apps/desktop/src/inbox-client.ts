import { operatorRead } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import { workspaceKey } from "../../../scripts/projects/scope";
import { codexChatApprovalPageSchema } from "../../../scripts/sessions/codex-chat-owned-protocol";
import { geminiChatApprovalPageSchema } from "../../../scripts/sessions/gemini-chat-owned-protocol";
import type { OwnedCodingSessionRecord } from "../../../types/codex-owned-task";
import type { ProjectsHome } from "../../../types/project-summary";
import type { ChatDecisionActivation } from "./chat-decision-owners";
import type { CodexChatDecisionIdentity } from "./codex-chat-decision-identities";
import type { GeminiChatDecisionIdentity } from "./gemini-chat-decision-identities";
import {
  type InboxCurrentPermissionItem,
  type InboxHeldPermissionItem,
  type InboxPermissionItem,
  type InboxPermissionProvider,
  type InboxPermissionSelection,
  type InboxPermissionSnapshot,
  type InboxSessionCoverage,
  permissionItemKey,
  permissionSelection,
} from "./inbox-model";
import type { DesktopRoute } from "./navigation";
import type { SessionProjectView, SessionsClient } from "./session-client";

const MAX_PERMISSION_SESSIONS = 256;
const READ_CONCURRENCY = 4;
let activeReads = 0;
const readQueue: Array<() => void> = [];
async function withReadSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeReads >= READ_CONCURRENCY)
    await new Promise<void>((resolve) => readQueue.push(resolve));
  else activeReads++;
  try {
    return await work();
  } finally {
    const next = readQueue.shift();
    if (next) next();
    else activeReads--;
  }
}
const approvalPath = (projectId: string, sessionId: string) =>
  `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/approvals`;

type HeldIdentity = CodexChatDecisionIdentity | GeminiChatDecisionIdentity;
type InboxSessionSource = Pick<SessionsClient, "refresh"> & {
  project(
    projectId: string,
  ): Pick<SessionProjectView, "records" | "loaded" | "loading" | "error">;
};
type InboxOwnedSession = Extract<
  OwnedCodingSessionRecord,
  { mode: "chat"; provider: InboxPermissionProvider }
>;

export interface InboxClient {
  snapshot(): InboxPermissionSnapshot;
  selectedPermission(): InboxPermissionItem | null;
  selectedActivation(): Omit<ChatDecisionActivation, "generation"> | null;
  currentSelection(): InboxPermissionSelection | null;
  selectPermission(key: string | null): boolean;
  syncRoute(route: DesktopRoute): void;
  refresh(input: {
    home: ProjectsHome | null;
    homeCurrent: boolean;
    sessions: InboxSessionSource;
  }): Promise<void>;
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

async function boundedMap<T, R>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await work(values[index]!);
      }
    }),
  );
  return results;
}

function isProvider(value: string): value is InboxPermissionProvider {
  return value === "codex" || value === "gemini";
}

/** Read-only, bounded source discovery. Selection is invalidated before each read begins. */
export function createInboxClient(deps: {
  heldOriginal(
    provider: InboxPermissionProvider,
    projectId: string,
    sessionId: string,
  ): HeldIdentity | null;
  read?(path: string): Promise<unknown>;
  now?(): string;
}): InboxClient {
  const listeners = new Set<() => void>();
  let disposed = false,
    generation = 0,
    selectionGeneration = 0,
    selectedKey: string | null = null,
    routeIdentity = "",
    snapshot: InboxPermissionSnapshot = {
      generation,
      loading: false,
      items: [],
      coverage: [],
      observedAt: null,
    };
  const tell = () => {
    if (!disposed) for (const listener of [...listeners]) listener();
  };
  const read =
    deps.read ??
    ((path: string) =>
      readOperatorRoute(path, { ...pageReads(), fetch: operatorRead }));
  const now = deps.now ?? (() => new Date().toISOString());
  const client: InboxClient = {
    snapshot: () => snapshot,
    selectedPermission() {
      if (!client.currentSelection() || !selectedKey) return null;
      return snapshot.items.find((item) => item.key === selectedKey) ?? null;
    },
    selectedActivation() {
      const item = client.selectedPermission();
      return item
        ? {
            projectId: item.projectId,
            workspace: item.workspace,
            sessionId: item.sessionId,
            acceptedTurnId: item.acceptedTurnId,
            requestId: item.offerId,
            turnRequestId: item.acceptedTurnId,
            actionable: item.state === "current" && item.actionable,
            inboxSelectionGeneration: selectionGeneration,
          }
        : null;
    },
    currentSelection() {
      if (disposed || snapshot.loading || !selectedKey) return null;
      const item = snapshot.items.find(
        (candidate) => candidate.key === selectedKey,
      );
      if (
        !item ||
        !item.complete ||
        item.snapshotGeneration !== generation ||
        snapshot.generation !== generation
      )
        return null;
      return permissionSelection(
        item,
        item.snapshotGeneration,
        generation,
        selectionGeneration,
        selectionGeneration,
      );
    },
    selectPermission(key) {
      selectionGeneration++;
      selectedKey = null;
      if (key !== null && !snapshot.loading) {
        const item = snapshot.items.find((candidate) => candidate.key === key);
        if (item?.complete) selectedKey = key;
      }
      tell();
      return selectedKey !== null;
    },
    syncRoute(route) {
      const next = `${route.destination}|${route.projectId ?? ""}|${route.selection?.kind ?? ""}|${route.selection?.id ?? ""}`;
      if (next === routeIdentity) return;
      routeIdentity = next;
      selectionGeneration++;
      selectedKey = null;
      tell();
    },
    async refresh({ home, homeCurrent, sessions }) {
      const current = ++generation;
      selectionGeneration++;
      selectedKey = null;
      const requestedAt = now();
      snapshot = {
        generation: current,
        loading: true,
        items: [],
        coverage: [],
        observedAt: requestedAt,
      };
      tell();
      const coverage: InboxSessionCoverage[] = [];
      if (disposed || !homeCurrent || !home) {
        if (current === generation && !disposed) {
          snapshot = {
            generation: current,
            loading: false,
            items: [],
            coverage: [
              {
                projectId: "",
                workspace: "",
                sessionId: null,
                provider: null,
                state: "unavailable",
                observedAt: requestedAt,
                reason:
                  "The current project and session catalog is unavailable.",
              },
            ],
            observedAt: requestedAt,
          };
          tell();
        }
        return;
      }

      const currentProjects = home.catalog.projects.filter((project) =>
        home.summaries.some(
          (summary) =>
            summary.projectId === project.id &&
            summary.complete &&
            summary.sessionsComplete &&
            summary.problems.length === 0 &&
            project.workspaces.some(
              (scope) =>
                workspaceKey(scope.root) === workspaceKey(summary.workspace),
            ),
        ),
      );
      for (const project of home.catalog.projects) {
        const summary = home.summaries.find(
          (item) => item.projectId === project.id,
        );
        if (
          !summary ||
          !summary.complete ||
          !summary.sessionsComplete ||
          summary.problems.length > 0 ||
          !project.workspaces.some(
            (scope) =>
              workspaceKey(scope.root) === workspaceKey(summary.workspace),
          )
        )
          coverage.push({
            projectId: project.id,
            workspace: summary?.workspace ?? "",
            sessionId: null,
            provider: null,
            state: "partial",
            observedAt: requestedAt,
            reason: "The project session snapshot is incomplete.",
          });
      }

      const projectSessions = await boundedMap(
        currentProjects,
        READ_CONCURRENCY,
        async (project) => {
          try {
            if (current !== generation || disposed) return null;
            await withReadSlot(() =>
              current === generation && !disposed
                ? sessions.refresh(project.id)
                : Promise.resolve(),
            );
            if (current !== generation || disposed) return null;
            const view = sessions.project(project.id);
            const summary = home.summaries.find(
              (item) => item.projectId === project.id,
            )!;
            if (!view.loaded || view.loading || view.error)
              throw Error("Owned session list is not current.");
            const records = view.records.filter(
              (record): record is InboxOwnedSession =>
                record.projectId === project.id &&
                record.origin === undefined &&
                record.mode === "chat" &&
                isProvider(record.provider) &&
                workspaceKey(record.workspace) ===
                  workspaceKey(summary.workspace),
            );
            if (records.length === 0)
              coverage.push({
                projectId: project.id,
                workspace: summary.workspace,
                sessionId: null,
                provider: null,
                state: "current",
                observedAt: now(),
                reason: null,
              });
            return { project, summary, records };
          } catch {
            const summary = home.summaries.find(
              (item) => item.projectId === project.id,
            )!;
            coverage.push({
              projectId: project.id,
              workspace: summary.workspace,
              sessionId: null,
              provider: null,
              state: "unavailable",
              observedAt: now(),
              reason: "The owned session list could not be verified.",
            });
            return { project, summary, records: [] };
          }
        },
      );
      const sessionsToRead = projectSessions
        .filter((entry) => entry !== null)
        .flatMap((entry) =>
          entry.records.map((record) => ({ ...entry, record })),
        );
      const boundedSessions = sessionsToRead.slice(0, MAX_PERMISSION_SESSIONS);
      if (sessionsToRead.length > boundedSessions.length)
        coverage.push({
          projectId: "",
          workspace: "",
          sessionId: null,
          provider: null,
          state: "partial",
          observedAt: now(),
          reason: "The bounded cross-project session scan reached its limit.",
        });

      const observedAt = now();
      const results = await boundedMap(
        boundedSessions,
        READ_CONCURRENCY,
        async ({ project, summary, record }) => {
          const provider = record.provider;
          let identity: HeldIdentity | null = null;
          const heldRow = (): InboxHeldPermissionItem | null => {
            if (!identity) return null;
            const heldAddress = {
              projectId: project.id,
              workspace: summary.workspace,
              provider,
              sessionId: record.id,
              acceptedTurnId: identity.turnRequestId,
              offerId: identity.approvalId,
            };
            return {
              ...heldAddress,
              kind: "permission",
              state: "held",
              complete: true,
              key: permissionItemKey(heldAddress),
              actionable: false,
              snapshotGeneration: current,
              observedAt,
              identity,
            };
          };
          try {
            identity = deps.heldOriginal(provider, project.id, record.id);
            if (current !== generation || disposed) return [];
            if (
              identity &&
              (identity.projectId !== project.id ||
                identity.sessionId !== record.id)
            )
              throw Error("Held decision identity did not match the session.");
            if (current !== generation || disposed) return [];
            const rawPage = await withReadSlot(() =>
              current === generation && !disposed
                ? read(approvalPath(project.id, record.id))
                : Promise.resolve(null),
            );
            if (current !== generation || disposed) return [];
            const sourceItems: {
              acceptedTurnId: string;
              offerId: string;
              actionable: boolean;
              approval: InboxCurrentPermissionItem["approval"];
            }[] = [];
            if (provider === "codex") {
              const page = codexChatApprovalPageSchema.parse(rawPage);
              if (
                page.receipt ||
                new Set(page.pending.map((item) => item.approval.id)).size !==
                  page.pending.length
              )
                throw Error("The protected approval page was ambiguous.");
              for (const pending of page.pending)
                sourceItems.push({
                  acceptedTurnId: pending.turnRequestId,
                  offerId: pending.approval.id,
                  actionable: pending.approval.availableDecisions.length > 0,
                  approval: { provider, value: pending.approval },
                });
            } else {
              const page = geminiChatApprovalPageSchema.parse(rawPage);
              if (
                page.receipt ||
                new Set(page.pending.map((item) => item.approval.id)).size !==
                  page.pending.length
              )
                throw Error("The protected approval page was ambiguous.");
              for (const pending of page.pending)
                sourceItems.push({
                  acceptedTurnId: pending.turnRequestId,
                  offerId: pending.approval.id,
                  actionable: pending.approval.options.length > 0,
                  approval: { provider, value: pending.approval },
                });
            }
            coverage.push({
              projectId: project.id,
              workspace: summary.workspace,
              sessionId: record.id,
              provider,
              state: "current",
              observedAt,
              reason: null,
            });
            const items: InboxPermissionItem[] = [];
            if (identity) {
              const item = heldRow();
              if (item) items.push(item);
              return items;
            }
            for (const source of sourceItems) {
              const address = {
                projectId: project.id,
                workspace: summary.workspace,
                provider,
                sessionId: record.id,
                acceptedTurnId: source.acceptedTurnId,
                offerId: source.offerId,
              };
              items.push({
                ...address,
                kind: "permission",
                state: "current",
                complete: true,
                key: permissionItemKey(address),
                actionable: source.actionable,
                snapshotGeneration: current,
                observedAt,
                approval: source.approval,
              });
            }
            return items;
          } catch {
            coverage.push({
              projectId: project.id,
              workspace: summary.workspace,
              sessionId: record.id,
              provider,
              state: "unavailable",
              observedAt: now(),
              reason:
                "The current protected approval or held decision could not be verified.",
            });
            const held = heldRow();
            return held ? [held] : [];
          }
        },
      );
      if (current !== generation || disposed) return;
      const items = results.flat();
      if (new Set(items.map((item) => item.key)).size !== items.length) {
        snapshot = {
          generation: current,
          loading: false,
          items: [],
          coverage: [
            ...coverage,
            {
              projectId: "",
              workspace: "",
              sessionId: null,
              provider: null,
              state: "unavailable",
              observedAt,
              reason:
                "The current permission snapshot contains duplicate identities.",
            },
          ],
          observedAt,
        };
      } else {
        snapshot = {
          generation: current,
          loading: false,
          items,
          coverage,
          observedAt,
        };
      }
      tell();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      generation++;
      selectionGeneration++;
      selectedKey = null;
      listeners.clear();
      snapshot = {
        generation,
        loading: false,
        items: [],
        coverage: [],
        observedAt: null,
      };
    },
  };
  return client;
}
