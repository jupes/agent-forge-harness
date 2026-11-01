import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import { operatorRead } from "../../../docs/js/operator";
import { workspaceKey } from "../../../scripts/projects/scope";
import { projectBeadsPageSchema } from "../../../scripts/projects/beads-protocol";
import type { BeadWriteNotice } from "./bead-writes-client";
import { withInboxReadSlot } from "./inbox-client";
import { desktopHref } from "./navigation";
import { bindInboxCardIdentity, type InboxCard, type InboxCoverage, type InboxSourceState } from "./inbox-view";

export interface InboxWriteSourceSnapshot {
  cards: readonly InboxCard[];
  coverage: readonly InboxCoverage[];
  membership: ReadonlyMap<string, boolean | null>;
  sourceGeneration: number;
  catalogRevision: number | null;
  routeGeneration: number;
  noticeSignature: string;
}

const projectBeadsPath = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/beads`;

/** Reads scoped bead membership for context; membership never proves an unknown write. */
export async function readInboxWriteSources(input: {
  notices: readonly BeadWriteNotice[];
  projects: readonly {
    id: string;
    name: string;
    archived: boolean;
    workspaces: readonly { root: string }[];
  }[];
  read?: (path: string) => Promise<unknown>;
  observedAt?: string;
  journalCurrent?: boolean;
  sourceGeneration?: number;
  catalogRevision?: number | null;
  routeGeneration?: number;
  noticeSignature?: string;
}): Promise<InboxWriteSourceSnapshot> {
  const read = input.read ?? ((path: string) =>
    readOperatorRoute(path, { ...pageReads(), fetch: operatorRead }));
  const observedAt = input.observedAt ?? new Date().toISOString();
  const relevant = input.notices.filter((notice) => notice.phase !== "sending");
  const scopes = new Map<string, { projectId: string; workspace: string }>();
  for (const notice of relevant) {
    const project = input.projects.find((item) => item.id === notice.projectId);
    if (!project || !project.workspaces.some((scope) =>
      workspaceKey(scope.root) === workspaceKey(notice.workspace))) continue;
    scopes.set(JSON.stringify([project.id, notice.workspace]), {
      projectId: project.id,
      workspace: notice.workspace,
    });
  }
  const results = await Promise.all([...scopes.entries()].map(async ([key, scope]) => {
    try {
      const page = projectBeadsPageSchema.parse(await withInboxReadSlot(() => read(projectBeadsPath(scope.projectId))));
      if (page.projectId !== scope.projectId || workspaceKey(page.workspace) !== workspaceKey(scope.workspace) || !page.complete || page.problems.length)
        throw Error("The current bead source was incomplete or out of scope.");
      return { key, beads: new Set(page.beads.map((bead) => bead.id)) };
    } catch {
      return { key, beads: null };
    }
  }));
  const byScope = results;
  const membership = new Map<string, boolean | null>();
  const cards: InboxCard[] = [];
  const coverage: InboxCoverage[] = [];
  const journalCurrent = input.journalCurrent ?? true;
  if (relevant.length === 0)
    coverage.push({
      sourceKind: "unknown-bead-write",
      state: journalCurrent ? "current" : "unavailable",
      reason: journalCurrent ? "The retained write journal is current and contains no outcomes." : "The retained write journal could not be verified.",
    });
  for (const notice of relevant) {
    const project = input.projects.find((item) => item.id === notice.projectId);
    const inScope = project?.workspaces.some((scope) =>
      workspaceKey(scope.root) === workspaceKey(notice.workspace));
    const scopeKey = JSON.stringify([notice.projectId, notice.workspace]);
    const beads = inScope
      ? byScope.find((result) => result.key === scopeKey)?.beads ?? null
      : null;
    const target = notice.createdId ?? notice.beadId;
    const member = target && beads ? beads.has(target) : null;
    membership.set(notice.key, member);
    const state: InboxSourceState = beads && journalCurrent ? "current" : "unavailable";
    coverage.push({
      sourceKind: "unknown-bead-write",
      state,
      reason: state === "current" ? "The exact project bead list was freshly read. This does not confirm whether the original write took effect." : "The exact project bead list could not be verified; the retained write remains visible.",
    });
    const noticeCard: InboxCard = {
      key: JSON.stringify([notice.workspace, notice.projectId, "unknown-bead-write", notice.key, `${notice.stage}:${notice.phase}:${notice.action}`]),
      projectId: notice.projectId,
      workspace: notice.workspace,
      projectName: project?.name ?? notice.projectId,
      sourceKind: "unknown-bead-write",
      stableItemId: notice.key,
      sourceRevision: `${notice.stage}:${notice.phase}:${notice.action}`,
      title: notice.title ?? `Bead write ${notice.action}`,
      detail:
        notice.phase === "unknown" && member === true
          ? `${notice.message} The bead currently exists; its presence does not confirm this write.`
          : notice.phase === "unknown" && member === false
            ? `${notice.message} The bead was not found in this read; absence does not prove the write never took effect.`
            : notice.message,
      observedAt,
      sourceState: state,
      resolved: false,
      canSnooze: false,
      canCheck: notice.phase !== "sending",
      checkHref: desktopHref({
        projectId: notice.projectId,
        destination: "beads",
        selection: target ? { kind: "bead", id: target } : null,
      }),
      checkLabel: target ?? "project beads",
      writePhase: notice.phase,
      unknownWriteKey: notice.key,
      notice: true,
    };
    cards.push(noticeCard);
    if (state === "current" && notice.phase === "unknown")
      cards.push({
        ...noticeCard,
        key: `${noticeCard.key}:action`,
        title: `Review ${notice.action} outcome`,
        detail: "Snooze only moves this action card. The original outcome notice remains visible until you dismiss it separately.",
        canSnooze: true,
        canCheck: false,
        notice: false,
      });
  }
  const identifiedCards = await Promise.all(
    cards.map(async (card) => {
      try {
        return await bindInboxCardIdentity(card);
      } catch {
        return {
          ...card,
          key: card.unknownWriteKey ?? card.key,
          stableItemId: card.unknownWriteKey ?? card.stableItemId,
          sourceState: "unavailable",
          canSnooze: false,
        } satisfies InboxCard;
      }
    }),
  );
  return {
    cards: identifiedCards,
    coverage,
    membership,
    sourceGeneration: input.sourceGeneration ?? 0,
    catalogRevision: input.catalogRevision ?? null,
    routeGeneration: input.routeGeneration ?? 0,
    noticeSignature: input.noticeSignature ?? JSON.stringify(input.notices),
  };
}
