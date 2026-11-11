import { comparableCheckout } from "../../../scripts/forge/runs";
import { projectRunDetailSchema } from "../../../scripts/projects/run-protocol";
import { workspaceKey } from "../../../scripts/projects/scope";
import type {
  ProjectRunDetail,
  ProjectRunGate,
} from "../../../types/project-runs";
import type {
  InboxSourceFactBase,
  InboxSourceRead,
} from "./inbox-bead-shift-source";
import type { InboxDispositionScope } from "./inbox-dispositions-client";

export type InboxGateEvidence = Readonly<Omit<ProjectRunGate, "checks">> & {
  readonly checks: readonly Readonly<ProjectRunGate["checks"][number]>[];
};
export interface InboxGateFact extends InboxSourceFactBase {
  sourceKind: "failed-gate";
  sourceIdentity: {
    readonly runSlug: string;
    readonly gate: InboxGateEvidence;
  };
  status: "pending";
}
export interface InboxGateProjectionInput {
  scope: InboxDispositionScope;
  runSlug: string;
  expectedCheckout: string;
  sourceGeneration: number;
  catalogRevision: number;
  detail: InboxSourceRead<ProjectRunDetail>;
}
export interface InboxGateProjection {
  scope: InboxDispositionScope;
  runSlug: string;
  expectedCheckout: string;
  sourceGeneration: number;
  catalogRevision: number;
  facts: readonly InboxGateFact[];
  coverage: InboxSourceRead<unknown>["coverage"];
  diagnostics: readonly string[];
}

/** Source-only projection: no current-state or disposition authority. */
export async function projectInboxGateSource(
  input: InboxGateProjectionInput,
): Promise<InboxGateProjection> {
  const scope = { ...input.scope },
    runSlug = input.runSlug,
    expectedCheckout = input.expectedCheckout,
    sourceGeneration = input.sourceGeneration,
    catalogRevision = input.catalogRevision,
    coverage = { ...input.detail.coverage };
  const capture = (raw: unknown): ProjectRunDetail | null => {
    try {
      const parsed = projectRunDetailSchema.safeParse(raw);
      if (!parsed.success) return null;
      const page = parsed.data;
      if (
        page.projectId !== scope.projectId ||
        workspaceKey(page.workspace) !== workspaceKey(scope.workspace) ||
        page.run.slug !== runSlug ||
        !comparableCheckout(expectedCheckout) ||
        comparableCheckout(page.checkout) !==
          comparableCheckout(expectedCheckout) ||
        !page.run.complete ||
        page.problems.length > 0 ||
        (page.gateHistory[0]?.passed ?? null) !== page.run.gatePassed
      )
        return null;
      let previousTime = Infinity;
      const identities = new Set<string>();
      for (const gate of page.gateHistory) {
        const time = Date.parse(gate.timestamp),
          key = JSON.stringify(gateKey(runSlug, gate));
        if (time > previousTime || identities.has(key)) return null;
        previousTime = time;
        identities.add(key);
      }
      return freeze(page);
    } catch {
      return null;
    }
  };
  // Both schema parses clone nested DTOs before the first digest await.
  const raw = capture(input.detail.raw),
    prior = capture(input.detail.lastVerified);
  const epochsValid = [sourceGeneration, catalogRevision].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
  const fresh =
    epochsValid &&
    raw !== null &&
    coverage.started === true &&
    coverage.settled === true &&
    coverage.complete === true &&
    coverage.fresh === true &&
    coverage.error === null;
  const selected = epochsValid ? (fresh ? raw : prior) : null;
  const result: InboxGateProjection = {
    scope,
    runSlug,
    expectedCheckout,
    sourceGeneration,
    catalogRevision,
    facts: [],
    coverage: {
      ...coverage,
      complete: fresh,
      fresh,
      error: fresh ? null : "Current gate source is not verified.",
    },
    diagnostics: fresh ? [] : ["Current gate source is not verified."],
  };
  const gate = selected?.gateHistory[0];
  if (!selected || !gate || gate.passed) return freeze(result);
  const identity = [
    "inbox-source-v1",
    workspaceKey(scope.workspace),
    scope.projectId,
    "failed-gate",
    gateKey(runSlug, gate),
  ];
  try {
    const stableItemId = await digest(identity);
    const sourceRevision = await digest([
      "inbox-revision-v1",
      identity,
      [
        gate.passed,
        gate.branch,
        gate.evaluatorEvidence,
        gate.checks.map((check) => [
          check.name,
          check.passed,
          check.skipped,
          check.detail,
        ]),
      ],
    ]);
    result.facts = [
      freeze<InboxGateFact>({
        ...scope,
        sourceKind: "failed-gate",
        stableItemId,
        sourceRevision,
        title: `Gate failed for ${selected.run.feature || runSlug}`,
        detail:
          "Latest recorded gate failed. Open the existing Run to inspect its evidence.",
        fresh,
        complete: fresh,
        resolved: false,
        unresolvedReason:
          "No independent resolution of this gate original was supplied.",
        sourceIdentity: { runSlug, gate },
        status: "pending",
      }),
    ];
  } catch {
    result.coverage = {
      ...result.coverage,
      complete: false,
      fresh: false,
      error: "Gate identity could not be verified.",
    };
    result.diagnostics = ["Gate identity could not be verified."];
  }
  return freeze(result);
}

function gateKey(runSlug: string, gate: ProjectRunGate) {
  return [
    "gate",
    runSlug,
    gate.event,
    gate.timestamp,
    comparableCheckout(gate.checkout ?? ""),
    gate.link,
    gate.beadsIssueId,
    gate.executionRunId,
    gate.forgeSlug,
  ];
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
