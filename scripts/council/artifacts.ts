import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, join, resolve } from "path";
import {
  type AggregatedFinding,
  COUNCIL_SCHEMA_VERSION,
  type CouncilRun,
  type FindingSeverity,
} from "./types";

export type CouncilArtifactPaths = {
  directory: string;
  manifest: string;
  events: string;
  report: string;
};

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  blocker: "Blocker",
  high: "High",
  medium: "Medium",
  low: "Low",
};

function findingMarkdown(finding: AggregatedFinding): string {
  return [
    `### [${SEVERITY_LABEL[finding.severity]}] ${finding.title}`,
    "",
    finding.claim,
    "",
    `**Consequence:** ${finding.consequence}`,
    "",
    `**Evidence:** ${finding.evidenceIds.map((id) => `\`${id}\``).join(", ") || "None supplied"}`,
    "",
    `**Council:** proposed by ${finding.proposedBy}; support ${finding.support}; oppose ${finding.oppose}; uncertain ${finding.uncertain}; confidence ${finding.confidence.toFixed(2)}${finding.contested ? "; contested" : ""}.`,
  ].join("\n");
}

export function renderCouncilReport(run: CouncilRun): string {
  const completedIndependent = run.records.filter(
    (record) => record.stage === "independent" && record.status === "completed",
  ).length;
  const completedPeers = run.records.filter(
    (record) => record.stage === "peer" && record.status === "completed",
  ).length;
  const findings =
    run.aggregatedFindings.length > 0
      ? run.aggregatedFindings.map(findingMarkdown).join("\n\n")
      : "No findings were aggregated.";
  const recommendations =
    run.chair && run.chair.recommendations.length > 0
      ? run.chair.recommendations
          .map((recommendation) => `- ${recommendation}`)
          .join("\n")
      : "- None recorded.";
  const failures =
    run.failures.length > 0
      ? run.failures
          .map(
            (failure) =>
              `- ${failure.stage}/${failure.seatId}: ${failure.error}`,
          )
          .join("\n")
      : "- None.";
  return [
    `# Council Review: ${run.context.source.displayName}`,
    "",
    `Run: \`${run.runId}\``,
    `Profile: \`${run.profile.id}\` (${run.profile.depth})`,
    `Status: **${run.status.toUpperCase()}**`,
    `Verdict: **${run.chair?.verdict ?? "unavailable"}**`,
    `Source hash: \`${run.context.contentHash}\``,
    "",
    "## Summary",
    "",
    run.chair?.summary ?? run.error ?? "No synthesis was produced.",
    "",
    "## Deliberation",
    "",
    `- Independent reviewers completed: ${completedIndependent}/${run.profile.seats.length}`,
    `- Peer ballots completed: ${completedPeers}/${run.profile.depth === "balanced" ? run.profile.seats.length : 0}`,
    `- Findings: ${run.aggregatedFindings.length}`,
    `- Estimated cost: $${run.estimatedCostUsd.toFixed(4)}`,
    `- Actual reported cost: $${run.actualCostUsd.toFixed(4)}`,
    "",
    "## Findings",
    "",
    findings,
    "",
    "## Recommendations",
    "",
    recommendations,
    "",
    "## Failures and Reduced Quorum",
    "",
    failures,
    "",
    "## Reproducibility",
    "",
    `- Started: ${run.startedAt}`,
    `- Finished: ${run.finishedAt}`,
    `- Context bytes: ${run.context.byteLength}${run.context.truncated ? " (truncated)" : ""}`,
    `- Event count: ${run.events.length}`,
    "",
  ].join("\n");
}

export function writeCouncilArtifacts(
  run: CouncilRun,
  runsRoot = resolve(process.cwd(), "reports", "council-runs"),
): CouncilArtifactPaths {
  if (!/^[a-zA-Z0-9._-]+$/.test(run.runId)) {
    throw new Error("runId contains unsafe path characters");
  }
  const directory = join(runsRoot, run.runId);
  mkdirSync(directory, { recursive: true });
  const manifest = join(directory, "manifest.json");
  const events = join(directory, "events.ndjson");
  const report = join(directory, "report.md");
  writeFileSync(manifest, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  writeFileSync(
    events,
    `${run.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  writeFileSync(report, renderCouncilReport(run), "utf8");
  return { directory, manifest, events, report };
}

function parseStoredRun(text: string): CouncilRun {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("stored council manifest is invalid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("stored council manifest must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== COUNCIL_SCHEMA_VERSION) {
    throw new Error("stored council manifest schemaVersion must be 1");
  }
  if (
    typeof record.runId !== "string" ||
    !/^[a-zA-Z0-9._-]+$/.test(record.runId)
  ) {
    throw new Error("stored council manifest has an invalid runId");
  }
  if (
    record.status !== "completed" &&
    record.status !== "failed" &&
    record.status !== "cancelled"
  ) {
    throw new Error("stored council manifest has an invalid status");
  }
  if (!Array.isArray(record.events) || !Array.isArray(record.records)) {
    throw new Error("stored council manifest is missing records or events");
  }
  return value as CouncilRun;
}

export function readCouncilRun(
  pathOrRunId: string,
  runsRoot = resolve(process.cwd(), "reports", "council-runs"),
): CouncilRun {
  let manifestPath: string;
  if (existsSync(pathOrRunId)) {
    manifestPath = statSync(pathOrRunId).isDirectory()
      ? join(pathOrRunId, "manifest.json")
      : pathOrRunId;
  } else {
    if (!/^[a-zA-Z0-9._-]+$/.test(pathOrRunId)) {
      throw new Error(`invalid run id: ${basename(pathOrRunId)}`);
    }
    manifestPath = join(runsRoot, pathOrRunId, "manifest.json");
  }
  if (!existsSync(manifestPath)) {
    throw new Error(`council manifest not found: ${manifestPath}`);
  }
  return parseStoredRun(readFileSync(manifestPath, "utf8"));
}
