import {
  councilOutcome,
  countFindingsBySeverity,
} from "../../../scripts/council/ledger-events";
import type { FindingSeverity } from "../../../scripts/council/types";
import { councilVerdictComment } from "../../../scripts/council/verdict-comment";
import { projectBeadsPageSchema } from "../../../scripts/projects/beads-protocol";
import { workspaceKey } from "../../../scripts/projects/scope";
import { parseBeadsIssueId } from "../../../scripts/run-correlation";
import type { ProjectBeadsPage } from "../../../types/project-beads";
import {
  type ProjectCouncilOriginalRead,
  projectCouncilOriginalReadSchema,
  projectCouncilRequestIdSchema,
} from "../../../types/project-council";
import {
  type ProjectCouncilRunRead,
  projectCouncilRunReadSchema,
} from "../../../types/project-council-run-read";
import type {
  InboxSourceFactBase,
  InboxSourceRead,
} from "./inbox-bead-shift-source";
import type { InboxDispositionScope } from "./inbox-dispositions-client";
import {
  councilVerdictInput,
  publishedContextMatches,
  verifyProjectCouncilOriginalRead,
} from "./project-council-proof";

export type InboxCouncilStatus =
  | "verified-posted"
  | "pending-result"
  | "no-completed-verdict"
  | "not-bead"
  | "unverified";
export interface InboxCouncilFact extends InboxSourceFactBase {
  sourceKind: "council-verdict";
  status: "informational";
  sourceIdentity: {
    requestId: string;
    intentHash: string;
    runId: string;
    beadId: string;
  };
  outcome: ReturnType<typeof councilOutcome>;
  findings: Readonly<Record<FindingSeverity, number>>;
}
export interface InboxCouncilProjectionInput {
  scope: InboxDispositionScope;
  requestId: string;
  sourceGeneration: number;
  catalogRevision: number;
  original: InboxSourceRead<ProjectCouncilOriginalRead>;
  result: InboxSourceRead<ProjectCouncilRunRead>;
  bead: InboxSourceRead<ProjectBeadsPage>;
}
export interface InboxCouncilProjection {
  scope: InboxDispositionScope;
  requestId: string;
  sourceGeneration: number;
  catalogRevision: number;
  status: InboxCouncilStatus;
  facts: readonly InboxCouncilFact[];
  coverage: InboxSourceRead<unknown>["coverage"];
  diagnostics: readonly string[];
}

type Snapshot = {
  original: ProjectCouncilOriginalRead | null;
  result: ProjectCouncilRunRead | null;
  bead: ProjectBeadsPage | null;
};
type ReadRun = NonNullable<NonNullable<ProjectCouncilRunRead["job"]>["run"]>;
type Posted = {
  original: ProjectCouncilOriginalRead["original"];
  run: ReadRun & { chair: NonNullable<ReadRun["chair"]> };
  beadId: string;
  comment: ProjectBeadsPage["beads"][number]["comments"][number];
};
type Joined =
  | { status: "verified-posted"; posted: Posted }
  | { status: Exclude<InboxCouncilStatus, "verified-posted">; posted: null };
const unverified = (
  status: Exclude<InboxCouncilStatus, "verified-posted"> = "unverified",
): Joined => ({ status, posted: null });

/** One captured request only; this is not an Inbox inventory or a Done proof. */
export async function projectInboxCouncilSource(
  input: InboxCouncilProjectionInput,
): Promise<InboxCouncilProjection> {
  const scope = { ...input.scope },
    requestId = input.requestId,
    sourceGeneration = input.sourceGeneration,
    catalogRevision = input.catalogRevision,
    coverages = [
      input.original.coverage,
      input.result.coverage,
      input.bead.coverage,
    ].map((value) => ({ ...value }));
  const capture = <T>(
    schema: { parse(value: unknown): T },
    raw: unknown,
  ): T | null => {
    try {
      // z.custom profiles retain aliases; parse alone is not a deep snapshot.
      return freeze(structuredClone(schema.parse(raw)));
    } catch {
      return null;
    }
  };
  const snapshot = (prior: boolean): Snapshot => ({
    original: capture(
      projectCouncilOriginalReadSchema,
      prior ? input.original.lastVerified : input.original.raw,
    ),
    result: capture(
      projectCouncilRunReadSchema,
      prior ? input.result.lastVerified : input.result.raw,
    ),
    bead: capture(
      projectBeadsPageSchema,
      prior ? input.bead.lastVerified : input.bead.raw,
    ),
  });
  // All six nested DTOs and all caller provenance are captured before hashing.
  const raw = snapshot(false),
    prior = snapshot(true);
  const expectedRequest = projectCouncilRequestIdSchema.safeParse(requestId);
  const epochsValid = [sourceGeneration, catalogRevision].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
  const readsCurrent = coverages.every(
    (coverage) =>
      coverage.started === true &&
      coverage.settled === true &&
      coverage.complete === true &&
      coverage.fresh === true &&
      coverage.error === null,
  );
  const join = async (value: Snapshot): Promise<Joined> => {
    if (!expectedRequest.success || !epochsValid || !value.original)
      return unverified();
    try {
      const originalRead = await verifyProjectCouncilOriginalRead(
        value.original,
        scope.projectId,
        scope.workspace,
        requestId,
      );
      const saved = originalRead.original;
      if (saved.runId !== `council-review-${requestId}`) return unverified();
      const kind = saved.context.source.kind;
      if (
        originalRead.metadata.sourceType !== (kind === "stdin" ? "text" : kind)
      )
        return unverified();
      if (!value.result) return unverified();
      const result = value.result,
        provenance = result.provenance,
        job = result.job;
      if (
        provenance.projectId !== scope.projectId ||
        provenance.workspace !== scope.workspace ||
        provenance.requestId !== saved.requestId ||
        provenance.intentHash !== saved.intentHash ||
        provenance.runId !== saved.runId ||
        provenance.catalogRevision !== saved.binding.catalogRevision ||
        provenance.scopeHash !== saved.binding.scopeHash ||
        canonical(result.receipt.metadata) !==
          canonical(originalRead.metadata) ||
        (job !== null && job.runId !== saved.runId) ||
        (job?.profile && canonical(job.profile) !== canonical(saved.profile)) ||
        (job?.run &&
          (!publishedContextMatches(job.run.context, saved.context) ||
            canonical(job.run.profile) !== canonical(saved.profile)))
      )
        return unverified();
      const phase = result.receipt.phase;
      if (phase === "unknown" || phase !== saved.state) return unverified();
      if (kind !== "bead") return unverified("not-bead");
      const beadId = parseBeadsIssueId(saved.context.source.locator);
      if (!beadId || beadId !== saved.context.source.locator)
        return unverified();
      if (phase === "reserved" || phase === "running")
        return unverified("pending-result");
      if (phase === "failed" || phase === "cancelled" || phase === "retired")
        return unverified("no-completed-verdict");
      const run = job?.run;
      if (
        !job ||
        job.status !== "completed" ||
        !run ||
        !run.chair ||
        run.status !== "completed" ||
        run.runId !== saved.runId
      )
        return unverified();
      if (
        run.context.source.kind !== "bead" ||
        run.context.source.locator !== beadId
      )
        return unverified();
      const completedRun = freeze({ ...run, chair: run.chair });
      const expectedComment = councilVerdictComment({
        runId: job.runId,
        status: job.status,
        run: councilVerdictInput(completedRun),
      });
      if (
        !expectedComment ||
        (result.verdictCommentPreview !== null &&
          result.verdictCommentPreview !== expectedComment)
      )
        return unverified();
      const page = value.bead;
      if (
        !page ||
        page.projectId !== scope.projectId ||
        workspaceKey(page.workspace) !== workspaceKey(scope.workspace) ||
        !page.complete ||
        page.problems.length > 0
      )
        return unverified();
      const rows = page.beads.filter((bead) => bead.id === beadId),
        bead = rows[0];
      if (rows.length !== 1 || !bead?.detailsLoaded || !bead.commentsComplete)
        return unverified();
      const comments = bead.comments.filter((comment) =>
        comment.body.startsWith(`review: COUNCIL ${saved.runId} `),
      );
      const comment = comments[0];
      if (comments.length !== 1 || !comment || comment.body !== expectedComment)
        return unverified();
      return {
        status: "verified-posted",
        posted: { original: saved, run: completedRun, beadId, comment },
      };
    } catch {
      return unverified();
    }
  };
  const current = await join(raw);
  const fresh = readsCurrent && current.status === "verified-posted";
  const status = readsCurrent ? current.status : "unverified";
  const retained = fresh ? unverified() : await join(prior);
  const posted =
    fresh && current.status === "verified-posted"
      ? current.posted
      : retained.status === "verified-posted"
        ? retained.posted
        : null;
  const result: InboxCouncilProjection = {
    scope,
    requestId,
    sourceGeneration,
    catalogRevision,
    status,
    facts: [],
    coverage: {
      started: coverages.every((value) => value.started === true),
      settled: coverages.every((value) => value.settled === true),
      complete: fresh,
      fresh,
      error: fresh
        ? null
        : "A current posted Council verdict could not be verified.",
    },
    diagnostics: fresh
      ? []
      : ["A current posted Council verdict could not be verified."],
  };
  if (!posted) return freeze(result);
  try {
    const verdict = councilVerdictInput(posted.run);
    const identity = [
      "inbox-source-v1",
      workspaceKey(scope.workspace),
      scope.projectId,
      "council-verdict",
      ["council", posted.beadId, requestId, posted.original.runId],
    ];
    const stableItemId = await digest(identity);
    const sourceRevision = await digest([
      "inbox-revision-v1",
      identity,
      [
        posted.original.intentHash,
        [
          verdict.status,
          verdict.chair ?? null,
          verdict.aggregatedFindings,
          posted.run.failures,
          posted.run.limitations,
        ],
        [posted.comment.body, posted.comment.author, posted.comment.createdAt],
      ],
    ]);
    const findings = countFindingsBySeverity(posted.run.aggregatedFindings),
      outcome = councilOutcome(verdict);
    result.facts = [
      freeze<InboxCouncilFact>({
        ...scope,
        sourceKind: "council-verdict",
        status: "informational",
        stableItemId,
        sourceRevision,
        sourceIdentity: {
          requestId,
          intentHash: posted.original.intentHash,
          runId: posted.original.runId,
          beadId: posted.beadId,
        },
        title: `Council verdict for ${posted.beadId}`,
        detail: `${outcome.toUpperCase()}: ${findings.blocker}/${findings.high}/${findings.medium}/${findings.low} findings (blocker/high/medium/low).`,
        outcome,
        findings,
        fresh,
        complete: fresh,
        resolved: false,
        unresolvedReason:
          "No independent retained-original resolution witness was supplied.",
      }),
    ];
  } catch {
    result.status = "unverified";
    result.coverage = {
      ...result.coverage,
      complete: false,
      fresh: false,
      error: "Council source identity could not be verified.",
    };
    result.diagnostics = ["Council source identity could not be verified."];
  }
  return freeze(result);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return `sha256:${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
