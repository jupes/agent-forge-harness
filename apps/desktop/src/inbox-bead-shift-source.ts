import { projectBeadsPageSchema } from "../../../scripts/projects/beads-protocol";
import { workspaceKey } from "../../../scripts/projects/scope";
import { projectWorkbenchPageSchema } from "../../../scripts/projects/workbench-protocol";
import type { OperatorMove } from "../../../scripts/scheduler/queue-table";
import { projectShiftsPageSchema } from "../../../scripts/shifts/protocol";
import type { ProjectBeadsPage } from "../../../types/project-beads";
import type { ProjectShiftsPage } from "../../../types/project-shifts";
import type { ProjectWorkbenchPage } from "../../../types/project-workbench";
import type { InboxDispositionScope } from "./inbox-dispositions-client";
import { verifyProjectShiftReceipt } from "./project-shift-receipt";

export interface InboxSourceRead<T> {
  raw: unknown;
  lastVerified: T | null;
  coverage: {
    started: boolean;
    settled: boolean;
    complete: boolean;
    fresh: boolean;
    error: string | null;
  };
}

export interface InboxBeadShiftProjectionInput {
  scope: InboxDispositionScope;
  sourceGeneration: number;
  catalogRevision: number;
  workbench: InboxSourceRead<ProjectWorkbenchPage>;
  beads: InboxSourceRead<ProjectBeadsPage>;
  shifts: InboxSourceRead<ProjectShiftsPage>;
}

export interface InboxSourceFactBase {
  projectId: string;
  workspace: string;
  stableItemId: string;
  sourceRevision: string;
  title: string;
  detail: string;
  fresh: boolean;
  complete: boolean;
  resolved: false;
  unresolvedReason: string;
}

export type InboxBeadShiftFact =
  | (InboxSourceFactBase & {
      sourceKind: "bead-approval";
      sourceIdentity: {
        beadId: string;
        updatedAt: string;
        queueState: "proposed";
        beadStatus: string;
        backed: true;
        allowedMoves: readonly OperatorMove[];
      };
      status: "pending";
    })
  | (InboxSourceFactBase & {
      sourceKind: "halted-bead";
      sourceIdentity: {
        beadId: string;
        updatedAt: string;
        queueState: "halted";
        beadStatus: string;
        backed: true;
        allowedMoves: readonly OperatorMove[];
      };
      status: "pending";
    })
  | (InboxSourceFactBase & {
      sourceKind: "stopped-shift";
      sourceIdentity: {
        shiftId: string;
        requestId: string;
        recomputedRequestHash: string;
        phase: "needs-recovery";
        reason: string | null;
      };
      status: "pending";
    })
  | (InboxSourceFactBase & {
      sourceKind: "stopped-shift";
      sourceIdentity: {
        shiftId: string;
        requestId: string;
        recomputedRequestHash: string;
        phase: "stopped";
        reason: string | null;
      };
      status: "informational";
    });

export interface InboxBeadShiftProjection {
  scope: InboxDispositionScope;
  sourceGeneration: number;
  catalogRevision: number;
  facts: readonly InboxBeadShiftFact[];
  coverage: Readonly<
    Record<
      "workbench" | "beads" | "shifts",
      InboxSourceRead<unknown>["coverage"]
    >
  >;
  diagnostics: readonly string[];
}

type JoinedBeadSources =
  | { coherent: false; candidates: []; reason: string }
  | {
      coherent: true;
      candidates: {
        card: ProjectWorkbenchPage["cards"][number];
        bead: ProjectBeadsPage["beads"][number];
      }[];
      reason: string;
    };
interface SelectedBeadSources
  extends Extract<JoinedBeadSources, { coherent: true }> {
  workbench: ProjectWorkbenchPage;
  beads: ProjectBeadsPage;
  fresh: boolean;
}

export async function projectInboxBeadShiftSources(
  input: InboxBeadShiftProjectionInput,
): Promise<InboxBeadShiftProjection> {
  const scope = { ...input.scope },
    sourceGeneration = input.sourceGeneration,
    catalogRevision = input.catalogRevision,
    workbenchRead: InboxSourceRead<ProjectWorkbenchPage> = {
      ...input.workbench,
      coverage: { ...input.workbench.coverage },
    },
    beadsRead: InboxSourceRead<ProjectBeadsPage> = {
      ...input.beads,
      coverage: { ...input.beads.coverage },
    },
    shiftsRead: InboxSourceRead<ProjectShiftsPage> = {
      ...input.shifts,
      coverage: { ...input.shifts.coverage },
    },
    diagnostics: string[] = [];
  const current = <T>(read: InboxSourceRead<T>) =>
    read.coverage.started &&
    read.coverage.settled &&
    read.coverage.complete &&
    read.coverage.fresh &&
    read.coverage.error === null;
  const scopeMatches = (page: { projectId: string; workspace: string }) =>
    page.projectId === scope.projectId &&
    workspaceKey(page.workspace) === workspaceKey(scope.workspace);
  const validWorkbench = (raw: unknown) => {
    const parsed = projectWorkbenchPageSchema.safeParse(raw);
    return parsed.success &&
      scopeMatches(parsed.data) &&
      parsed.data.complete &&
      parsed.data.problems.length === 0
      ? parsed.data
      : null;
  };
  const validBeads = (raw: unknown) => {
    const parsed = projectBeadsPageSchema.safeParse(raw);
    return parsed.success &&
      scopeMatches(parsed.data) &&
      parsed.data.complete &&
      parsed.data.problems.length === 0
      ? parsed.data
      : null;
  };
  const workbenchRaw = validWorkbench(workbenchRead.raw),
    beadsRaw = validBeads(beadsRead.raw),
    shiftsRaw = projectShiftsPageSchema.safeParse(shiftsRead.raw),
    workbenchLastVerified = validWorkbench(workbenchRead.lastVerified),
    beadsLastVerified = validBeads(beadsRead.lastVerified),
    shiftsLastVerified = projectShiftsPageSchema.safeParse(
      shiftsRead.lastVerified,
    ),
    workbenchIsCurrent = current(workbenchRead) && workbenchRaw !== null,
    beadsIsCurrent = current(beadsRead) && beadsRaw !== null;
  const rawPair =
      workbenchRaw && beadsRaw ? joinBeadSources(workbenchRaw, beadsRaw) : null,
    retainedPair =
      workbenchLastVerified && beadsLastVerified
        ? joinBeadSources(workbenchLastVerified, beadsLastVerified)
        : null;
  let currentPair: SelectedBeadSources | null = null,
    priorPair: SelectedBeadSources | null = null,
    staleRawPair: SelectedBeadSources | null = null;
  if (
    workbenchIsCurrent &&
    beadsIsCurrent &&
    rawPair?.coherent &&
    workbenchRaw &&
    beadsRaw
  )
    currentPair = {
      ...rawPair,
      workbench: workbenchRaw,
      beads: beadsRaw,
      fresh: true,
    };
  if (retainedPair?.coherent && workbenchLastVerified && beadsLastVerified)
    priorPair = {
      ...retainedPair,
      workbench: workbenchLastVerified,
      beads: beadsLastVerified,
      fresh: false,
    };
  if (rawPair?.coherent && workbenchRaw && beadsRaw)
    staleRawPair = {
      ...rawPair,
      workbench: workbenchRaw,
      beads: beadsRaw,
      fresh: false,
    };
  const beadPair = currentPair ?? priorPair ?? staleRawPair;
  if (!currentPair) {
    diagnostics.push(
      rawPair && !rawPair.coherent
        ? rawPair.reason
        : "A coherent complete current Workbench/Beads pair is unavailable.",
    );
  }
  if (retainedPair && !retainedPair.coherent)
    diagnostics.push(retainedPair.reason);
  let shiftsRawVerified: ProjectShiftsPage | null = null;
  if (
    shiftsRaw.success &&
    shiftsRaw.data.projectId === scope.projectId &&
    current(shiftsRead)
  ) {
    try {
      for (const receipt of shiftsRaw.data.items) {
        await verifyProjectShiftReceipt(scope, receipt, {
          requestId: receipt.intent.request.requestId,
          requestHash: receipt.intent.requestHash,
          shiftId: receipt.intent.shiftId,
        });
      }
      shiftsRawVerified = shiftsRaw.data;
    } catch {
      diagnostics.push("Shift original verification failed.");
    }
  }

  let shiftsRetained: ProjectShiftsPage | null = shiftsRawVerified;
  if (!shiftsRetained) {
    const candidates = [
      shiftsLastVerified.success ? shiftsLastVerified.data : null,
      shiftsRaw.success ? shiftsRaw.data : null,
    ];
    for (const candidate of candidates) {
      const checked = projectShiftsPageSchema.safeParse(candidate);
      if (!checked.success || checked.data.projectId !== scope.projectId)
        continue;
      try {
        for (const receipt of checked.data.items) {
          await verifyProjectShiftReceipt(scope, receipt, {
            requestId: receipt.intent.request.requestId,
            requestHash: receipt.intent.requestHash,
            shiftId: receipt.intent.shiftId,
          });
        }
        shiftsRetained = checked.data;
        break;
      } catch {
        diagnostics.push("Retained shift original verification failed.");
      }
    }
  }

  const facts: InboxBeadShiftFact[] = [];
  if (beadPair) {
    for (const { card, bead } of beadPair.candidates) {
      const { entry } = card;
      if (entry.state !== "proposed" && entry.state !== "halted") continue;
      const sourceKind =
          entry.state === "proposed" ? "bead-approval" : "halted-bead",
        allowedMoves = beadPair.fresh ? [...card.moves] : [];
      const itemTuple = [
        "inbox-source-v1",
        workspaceKey(scope.workspace),
        scope.projectId,
        sourceKind,
        ["bead", bead.id],
      ];
      const sourceVersion = [
        "bead-version-v1",
        bead.updatedAt,
        bead.status,
        bead.queue ?? "",
        entry.state,
        entry.status,
        String(entry.backed),
        ...[...card.moves].sort(),
      ];
      const stableItemId = await canonicalHash(itemTuple),
        sourceRevision = await revisionHash(itemTuple, sourceVersion),
        common: InboxSourceFactBase = {
          projectId: scope.projectId,
          workspace: scope.workspace,
          stableItemId,
          sourceRevision,
          title: entry.title,
          detail: card.note ?? bead.description,
          fresh: beadPair.fresh,
          complete: beadPair.fresh,
          resolved: false,
          unresolvedReason:
            "No independent exact-original resolution witness is available.",
        };
      if (entry.state === "proposed") {
        facts.push({
          ...common,
          sourceKind: "bead-approval",
          sourceIdentity: {
            beadId: entry.beadId,
            updatedAt: bead.updatedAt,
            queueState: "proposed",
            beadStatus: bead.status,
            backed: true,
            allowedMoves,
          },
          status: "pending",
        });
      } else {
        facts.push({
          ...common,
          sourceKind: "halted-bead",
          sourceIdentity: {
            beadId: entry.beadId,
            updatedAt: bead.updatedAt,
            queueState: "halted",
            beadStatus: bead.status,
            backed: true,
            allowedMoves,
          },
          status: "pending",
        });
      }
    }
  }

  if (shiftsRetained) {
    for (const receipt of shiftsRetained.items) {
      const { intent, observation } = receipt;
      if (
        observation.phase !== "needs-recovery" &&
        observation.phase !== "stopped"
      )
        continue;
      const itemTuple = [
        "inbox-source-v1",
        workspaceKey(scope.workspace),
        scope.projectId,
        "stopped-shift",
        ["shift", intent.shiftId, intent.request.requestId],
      ];
      const sourceVersion = [
        "shift-version-v1",
        intent.requestHash,
        observation.phase,
        observation.reason ?? "",
      ];
      const stableItemId = await canonicalHash(itemTuple),
        sourceRevision = await revisionHash(itemTuple, sourceVersion),
        shiftsIsCurrent = shiftsRawVerified !== null;
      const common: InboxSourceFactBase = {
        projectId: scope.projectId,
        workspace: scope.workspace,
        stableItemId,
        sourceRevision,
        title: `Shift ${intent.shiftId}`,
        detail: observation.reason ?? "",
        fresh: shiftsIsCurrent,
        complete: shiftsIsCurrent,
        resolved: false,
        unresolvedReason:
          "No independent exact-original resolution witness is available.",
      };
      if (observation.phase === "needs-recovery") {
        facts.push({
          ...common,
          sourceKind: "stopped-shift",
          sourceIdentity: {
            shiftId: intent.shiftId,
            requestId: intent.request.requestId,
            recomputedRequestHash: intent.requestHash,
            phase: "needs-recovery",
            reason: observation.reason,
          },
          status: "pending",
        });
      } else {
        facts.push({
          ...common,
          sourceKind: "stopped-shift",
          sourceIdentity: {
            shiftId: intent.shiftId,
            requestId: intent.request.requestId,
            recomputedRequestHash: intent.requestHash,
            phase: "stopped",
            reason: observation.reason,
          },
          status: "informational",
        });
      }
    }
  } else {
    diagnostics.push("No verified shift page is available.");
  }

  const coverage = {
    workbench: readCoverage(workbenchRead, currentPair !== null),
    beads: readCoverage(beadsRead, currentPair !== null),
    shifts: readCoverage(shiftsRead, shiftsRawVerified !== null),
  };
  return {
    scope,
    sourceGeneration,
    catalogRevision,
    facts,
    coverage,
    diagnostics,
  };
}

function joinBeadSources(
  workbench: ProjectWorkbenchPage,
  beads: ProjectBeadsPage,
): JoinedBeadSources {
  const cardCounts = new Map<string, number>(),
    beadById = new Map(beads.beads.map((bead) => [bead.id, bead])),
    candidates: {
      card: ProjectWorkbenchPage["cards"][number];
      bead: ProjectBeadsPage["beads"][number];
    }[] = [];
  for (const card of workbench.cards)
    cardCounts.set(
      card.entry.beadId,
      (cardCounts.get(card.entry.beadId) ?? 0) + 1,
    );
  for (const card of workbench.cards) {
    const { entry } = card;
    if (entry.state !== "proposed" && entry.state !== "halted") continue;
    if (entry.backed !== true) continue;
    if (entry.state === "proposed" && !card.moves.includes("approve")) continue;
    if (cardCounts.get(entry.beadId) !== 1)
      return {
        coherent: false,
        candidates: [],
        reason: `Duplicate Workbench identity: ${entry.beadId}`,
      };
    const bead = beadById.get(entry.beadId);
    if (
      !bead ||
      bead.queue !== entry.state ||
      bead.status !== entry.status ||
      bead.updatedAt !== card.updatedAt
    )
      return {
        coherent: false,
        candidates: [],
        reason: `Workbench and Beads original mismatch: ${entry.beadId}`,
      };
    candidates.push({ card, bead });
  }
  return { coherent: true, candidates, reason: "" };
}

type CanonicalValue = string | readonly CanonicalValue[];

async function canonicalHash(value: CanonicalValue) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function revisionHash(
  identityTuple: CanonicalValue,
  sourceVersion: readonly string[],
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify(["inbox-revision-v1", identityTuple, sourceVersion]),
    ),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;
}

function readCoverage<T>(read: InboxSourceRead<T>, verified: boolean) {
  return {
    ...read.coverage,
    complete: verified,
    fresh: verified,
    error: verified
      ? null
      : (read.coverage.error ??
        "Source read is incomplete, stale, malformed, or out of scope."),
  };
}
