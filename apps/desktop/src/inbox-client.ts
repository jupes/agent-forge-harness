import { operatorRead } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import { workspaceKey } from "../../../scripts/projects/scope";
import { codexChatApprovalPageSchema } from "../../../scripts/sessions/codex-chat-owned-protocol";
import { geminiChatApprovalPageSchema } from "../../../scripts/sessions/gemini-chat-owned-protocol";
import { ownedCodingPageSchema } from "../../../scripts/sessions/codex-owned-journal";
import type { ConversationFrame, ConversationPage } from "../../../types/conversation";
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
export async function withInboxReadSlot<T>(
  work: () => Promise<T>,
): Promise<T> {
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
const conversationPagePath = (projectId: string, sessionId: string, after: number, requestId: string) =>
  `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}?after=${after}&limit=100&requestId=${encodeURIComponent(requestId)}`;
const MAX_CONVERSATION_PAGES = 200;

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
  permissionResolutions(): readonly InboxTerminalPermissionProof[];
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

export interface InboxTerminalPermissionProof {
  permissionKey: string;
  projectId: string;
  workspace: string;
  provider: InboxPermissionProvider;
  sessionId: string;
  acceptedTurnId: string;
  offerId: string;
  snapshotGeneration: number;
  conversationRevision: number;
  lastSequence: number;
  complete: true;
  resolved: true;
}

export function exactTerminalPermissionJoin(
  candidate: InboxCurrentPermissionItem,
  frames: readonly ConversationFrame[],
  version: string,
): boolean {
  if (candidate.approval.provider === "codex") {
    const offers = frames.filter((frame) =>
      frame.turnId === candidate.acceptedTurnId &&
      frame.event.kind === "coding-chat" &&
      frame.event.version === version &&
      frame.event.event.kind === "approval-request" &&
      frame.event.event.approval.id === candidate.offerId,
    );
    if (offers.length !== 1) return false;
    const offer = offers[0];
    if (!offer) return false;
    if (offer.event.kind !== "coding-chat" || offer.event.event.kind !== "approval-request") return false;
    const offered = offer.event.event.approval;
    const current = candidate.approval.value;
    if (
      offered.kind !== current.kind ||
      offered.command !== current.command ||
      offered.cwd !== current.cwd ||
      offered.reason !== current.reason ||
      JSON.stringify(offered.availableDecisions) !== JSON.stringify(current.availableDecisions)
    ) return false;
    const resolutions = frames.filter((frame) =>
      frame.seq > offer.seq &&
      frame.turnId === candidate.acceptedTurnId &&
      frame.event.kind === "coding-chat" &&
      frame.event.version === version &&
      frame.event.event.kind === "approval-resolved" &&
      frame.event.event.approvalId === candidate.offerId &&
      (frame.event.event.source === "serverRequest/resolved" ||
        frame.event.event.source === "turn/completed"),
    );
    return resolutions.length === 1;
  }

  if (version !== "0.65.0") return false;

  const offers = frames.filter((frame) =>
    frame.turnId === candidate.acceptedTurnId &&
    frame.event.kind === "coding-gemini-chat" &&
    frame.event.version === "0.65.0" &&
    frame.event.event.kind === "approval-offer" &&
    frame.event.event.requestId === candidate.acceptedTurnId &&
    frame.event.event.id === candidate.offerId,
  );
  if (offers.length !== 1) return false;
  const offer = offers[0];
  if (!offer || offer.event.kind !== "coding-gemini-chat" || offer.event.event.kind !== "approval-offer") return false;
  const toolCallId = offer.event.event.toolCallId;
  return frames.some((frame) =>
    frame.seq > offer.seq &&
    frame.turnId === candidate.acceptedTurnId &&
    frame.event.kind === "coding-gemini-chat" &&
    frame.event.version === "0.65.0" &&
    ((frame.event.event.kind === "tool" &&
      frame.event.event.scope === "turn" &&
      frame.event.event.requestId === candidate.acceptedTurnId &&
      frame.event.event.toolCallId === toolCallId &&
      (frame.event.event.status === "completed" || frame.event.event.status === "failed")) ||
      (frame.event.event.kind === "result" &&
        frame.event.event.requestId === candidate.acceptedTurnId)),
  );
}

async function readCompletePermissionConversation(
  input: {
    projectId: string;
    sessionId: string;
    acceptedTurnId: string;
    provider: InboxPermissionProvider;
    workspace: string;
  },
  read: (path: string) => Promise<unknown>,
): Promise<{ page: ConversationPage; frames: readonly ConversationFrame[] }> {
  let after = 0;
  let revision: number | null = null;
  let lastSequence: number | null = null;
  let bindingVersion: string | null = null;
  const frames: ConversationFrame[] = [];
  const seenSequences = new Set<number>();
  for (let index = 0; index < MAX_CONVERSATION_PAGES; index++) {
    const parsed = ownedCodingPageSchema.safeParse(await withInboxReadSlot(() =>
      read(conversationPagePath(input.projectId, input.sessionId, after, input.acceptedTurnId)),
    ));
    if (!parsed.success) throw Error("The protected session history page was incomplete.");
    const page = parsed.data;
    if (
      page.projectId !== input.projectId ||
      page.conversationId !== input.sessionId ||
      !page.binding ||
      page.binding.sessionId !== input.sessionId ||
      page.binding.provider !== input.provider ||
      page.request?.requestId !== input.acceptedTurnId
    ) throw Error("The protected session history did not match its exact Inbox source.");
    if (revision === null) {
      revision = page.revision;
      lastSequence = page.lastSequence;
      bindingVersion = page.binding.version;
    } else if (page.revision !== revision || page.lastSequence !== lastSequence || page.binding.version !== bindingVersion) {
      throw Error("The protected session history changed while paging.");
    }
    let previousSequence = after;
    for (const frame of page.frames) {
      if (frame.seq <= previousSequence || seenSequences.has(frame.seq))
        throw Error("The protected session history cursor repeated a frame.");
      previousSequence = frame.seq;
      seenSequences.add(frame.seq);
      frames.push(frame);
    }
    if (page.frames.length > 0 && page.nextCursor !== page.frames.at(-1)?.seq)
      throw Error("The protected session history cursor did not match its final frame.");
    if (page.more) {
      if (page.frames.length === 0 || page.nextCursor <= after)
        throw Error("The protected session history cursor did not advance.");
      after = page.nextCursor;
      continue;
    }
    if (page.nextCursor !== page.lastSequence)
      throw Error("The protected session history did not reach its terminal sequence.");
    if (frames.length !== page.lastSequence || frames.some((frame, index) => frame.seq !== index + 1))
      throw Error("The protected session history did not contain every source sequence.");
    return { page, frames };
  }
  throw Error("The protected session history exceeded its page bound.");
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
    permissionResolutions: readonly InboxTerminalPermissionProof[] = [],
    snapshot: InboxPermissionSnapshot = {
      generation,
      loading: false,
      items: [],
      coverage: [],
      observedAt: null,
    };
  const knownPermissionItems = new Map<string, InboxCurrentPermissionItem>();
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
    permissionResolutions: () => permissionResolutions,
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
      permissionResolutions = [];
      selectionGeneration++;
      selectedKey = null;
      tell();
    },
    async refresh({ home, homeCurrent, sessions }) {
      const previousItems = snapshot.items;
      const current = ++generation;
      permissionResolutions = [];
      selectionGeneration++;
      selectedKey = null;
      const requestedAt = now();
      snapshot = {
        generation: current,
        loading: true,
        items: previousItems,
        coverage: snapshot.coverage,
        observedAt: requestedAt,
      };
      tell();
      const coverage: InboxSessionCoverage[] = [];
      if (disposed || !homeCurrent || !home) {
        if (current === generation && !disposed) {
          snapshot = {
            generation: current,
            loading: false,
            items: previousItems,
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
            await withInboxReadSlot(() =>
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
      if (sessionsToRead.length > boundedSessions.length) {
        coverage.push({
          projectId: "",
          workspace: "",
          sessionId: null,
          provider: null,
          state: "partial",
          observedAt: now(),
          reason: "The bounded cross-project session scan reached its limit.",
        });
        const skippedProjectIds = new Set<string>();
        for (const skippedProject of sessionsToRead.slice(MAX_PERMISSION_SESSIONS).map((entry) => entry.project))
          if (!skippedProjectIds.has(skippedProject.id)) {
            skippedProjectIds.add(skippedProject.id);
            coverage.push({
              projectId: skippedProject.id,
              workspace: skippedProject.summary.workspace,
              sessionId: null,
              provider: null,
              state: "partial",
              observedAt: now(),
              reason: "The bounded session scan did not inspect every source session.",
            });
          }
      }

      const observedAt = now();
      const verifiedResolutions: InboxTerminalPermissionProof[] = [];
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
            const rawPage = await withInboxReadSlot(() =>
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
                (page.receipt && (page.pending.length > 0 || page.receipt.projectId !== project.id || page.receipt.sessionId !== record.id)) ||
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
                (page.receipt && (page.pending.length > 0 || page.receipt.projectId !== project.id || page.receipt.sessionId !== record.id)) ||
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
              const item: InboxCurrentPermissionItem = {
                ...address,
                kind: "permission",
                state: "current",
                complete: true,
                key: permissionItemKey(address),
                actionable: source.actionable,
                snapshotGeneration: current,
                observedAt,
                approval: source.approval,
              };
              items.push(item);
              knownPermissionItems.set(item.key, item);
            }
            const pendingKeys = new Set(items.map((item) => item.key));
            const historical = [...knownPermissionItems.values()].filter(
              (item) =>
                item.projectId === project.id &&
                workspaceKey(item.workspace) === workspaceKey(summary.workspace) &&
                item.sessionId === record.id &&
                item.provider === provider &&
                !pendingKeys.has(item.key),
            );
            if (historical.length > 0) {
              const byTurn = new Map<string, InboxCurrentPermissionItem[]>();
              for (const prior of historical) {
                const group = byTurn.get(prior.acceptedTurnId) ?? [];
                group.push(prior);
                byTurn.set(prior.acceptedTurnId, group);
              }
              for (const [acceptedTurnId, candidates] of byTurn) {
                try {
                  const history = await readCompletePermissionConversation(
                    { projectId: project.id, workspace: summary.workspace, provider, sessionId: record.id, acceptedTurnId },
                    read,
                  );
                  if (current !== generation || disposed) return [];
                  for (const prior of candidates) {
                    const resolved = exactTerminalPermissionJoin(prior, history.frames, history.page.binding?.version ?? "");
                    if (!resolved) continue;
                    items.push({ ...prior, snapshotGeneration: current, actionable: false, observedAt });
                    verifiedResolutions.push({
                      permissionKey: prior.key,
                      projectId: prior.projectId,
                      workspace: prior.workspace,
                      provider: prior.provider,
                      sessionId: prior.sessionId,
                      acceptedTurnId: prior.acceptedTurnId,
                      offerId: prior.offerId,
                      snapshotGeneration: current,
                      conversationRevision: history.page.revision,
                      lastSequence: history.page.lastSequence,
                      complete: true,
                      resolved: true,
                    });
                  }
                  if (candidates.some((item) => !items.some((candidate) => candidate.key === item.key)))
                    coverage.push({
                      projectId: project.id,
                      workspace: summary.workspace,
                      sessionId: record.id,
                      provider,
                      state: "partial",
                      observedAt,
                      reason: "An original permission remains visible because its exact terminal source join was not confirmed.",
                    });
                } catch {
                  coverage.push({
                    projectId: project.id,
                    workspace: summary.workspace,
                    sessionId: record.id,
                    provider,
                    state: "unavailable",
                    observedAt,
                    reason: "The exact original permission history could not be verified; the prior row remains visible without Done authority.",
                  });
                }
              }
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
      const freshItems = results.flat();
      const freshKeys = new Set(freshItems.map((item) => item.key));
      const listedSessionKeys = new Set(boundedSessions.map(({ project, record }) => JSON.stringify([project.id, record.id])));
      for (const prior of previousItems) {
        if (freshKeys.has(prior.key) || listedSessionKeys.has(JSON.stringify([prior.projectId, prior.sessionId]))) continue;
        if (!coverage.some((entry) => entry.projectId === prior.projectId && entry.sessionId === prior.sessionId && entry.state !== "current"))
          coverage.push({
            projectId: prior.projectId,
            workspace: prior.workspace,
            sessionId: prior.sessionId,
            provider: prior.provider,
            state: "partial",
            observedAt,
            reason: "The original session is no longer present in the current session inventory; its permission outcome remains unverified.",
          });
      }
      const retainedStale = previousItems.filter((item) => {
        if (freshKeys.has(item.key)) return false;
        const scoped = coverage.filter(
          (entry) =>
            entry.projectId === item.projectId &&
            workspaceKey(entry.workspace) === workspaceKey(item.workspace) &&
            (entry.sessionId === null || entry.sessionId === item.sessionId),
        );
        return scoped.some((entry) => entry.state !== "current");
      });
      const items = [...freshItems, ...retainedStale];
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
      permissionResolutions = verifiedResolutions;
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
      knownPermissionItems.clear();
      permissionResolutions = [];
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
