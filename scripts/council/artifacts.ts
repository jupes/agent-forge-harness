import { randomUUID } from "crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { ballotChanged, previousBallot, roundTitle } from "./discussion";
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
    `**Council:** ${finding.resolution ?? "reviewed"}; proposed by ${finding.proposedBy}; support ${finding.support}; oppose ${finding.oppose}; uncertain ${finding.uncertain}; confidence ${finding.confidence.toFixed(2)}${finding.contested ? "; contested" : ""}.`,
    "",
    ...(finding.rationales ?? []).map(
      (rationale) =>
        `- **${rationale.reviewerLabel} (${rationale.stance}):** ${rationale.reason}`,
    ),
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
    `- Peer ballots completed: ${completedPeers}/${run.profile.depth !== "quick" ? run.profile.seats.length : 0}`,
    `- Revision responses completed: ${run.records.filter((record) => record.stage === "revision" && record.status === "completed").length}`,
    `- Findings: ${run.aggregatedFindings.length}`,
    `- Estimated cost: $${run.estimatedCostUsd.toFixed(4)}`,
    `- Actual reported cost: ${run.actualCostUsd == null ? "unavailable" : `$${run.actualCostUsd.toFixed(4)}`}`,
    `- Usage-derived estimate: ${run.usageEstimatedCostUsd == null ? "unavailable" : `$${run.usageEstimatedCostUsd.toFixed(4)}`}`,
    `- Budget-accounted cost: $${(run.accountedCostUsd ?? run.estimatedCostUsd).toFixed(4)}${run.costIsEstimate ? " (conservative estimate)" : ""}`,
    "",
    "## Limitations",
    "",
    ...(run.limitations?.length
      ? run.limitations.map((item) => `- ${item}`)
      : ["- None recorded."]),
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
    "## Supplied evidence",
    "",
    ...(run.context.evidence ?? []).flatMap((item) => [
      `### ${item.id}: ${item.title}`,
      "",
      ...item.content
        .split("\n")
        .map((line, index) => `    ${index + 1}: ${line}`),
      "",
    ]),
    "## Round-by-round discussion",
    "",
    ...(run.discussion ?? []).flatMap((round, index, rounds) => [
      `### ${roundTitle(round)}`,
      "",
      ...round.records.flatMap((record) => {
        const output = record.output;
        const lines = [
          `#### ${record.seatId} (${record.provider} / ${record.model})`,
          "",
          `Status: ${record.status}`,
          "",
        ];
        if (record.error) lines.push(record.error, "");
        if (output && "findings" in output) {
          lines.push(
            `Initial verdict: ${output.verdict}`,
            "",
            ...output.findings.flatMap((finding) => [
              `- **${finding.title} (${finding.severity}):** ${finding.claim} Consequence: ${finding.consequence} Evidence: ${finding.evidenceIds.join(", ")}`,
              "",
            ]),
            ...output.strengths.map((text) => `- Strength: ${text}`),
            ...output.unknowns.map((text) => `- Unknown: ${text}`),
            "",
          );
        }
        if (output && "ballots" in output) {
          for (const ballot of output.ballots) {
            const previous = previousBallot(
              rounds,
              index,
              record.seatId,
              ballot.candidateId,
            );
            lines.push(
              `- **${round.candidateTitles[ballot.candidateId] ?? ballot.candidateId} (${ballot.stance}):** ${ballot.reason} Evidence: ${ballot.evidenceIds.join(", ") || "none"}.`,
              "",
            );
            if (previous && ballotChanged(previous, ballot))
              lines.push(
                `  Changed from ${previous.stance} to ${ballot.stance}; severity ${previous.suggestedSeverity ?? "as proposed"} to ${ballot.suggestedSeverity ?? "as proposed"}. Earlier rationale: ${previous.reason}`,
                "",
              );
          }
          lines.push(
            ...output.missingFindings.map(
              (finding) =>
                `- New finding: **${finding.title} (${finding.severity})** — ${finding.claim} Evidence: ${finding.evidenceIds.join(", ")}`,
            ),
            "",
          );
        }
        return lines;
      }),
    ]),
  ].join("\n");
}

export function writeCouncilArtifacts(
  run: CouncilRun,
  runsRoot = resolve(process.cwd(), "reports", "council-runs"),
  reservation?: CouncilRunReservation,
): CouncilArtifactPaths {
  const owned = reservation ?? reserveCouncilRun(run.runId, runsRoot);
  assertReservation(owned, run.runId, runsRoot);
  const { directory, manifest, events, report } = owned.paths;
  writeFileSync(
    events,
    `${run.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  writeFileSync(report, renderCouncilReport(run), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  // The manifest is the commit marker: readers only see a complete run.
  writeFileSync(manifest, `${JSON.stringify(run, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return { directory, manifest, events, report };
}

export function assertCouncilRunId(runId: string): void {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(runId) ||
    runId.endsWith(".") ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(runId)
  ) {
    throw new Error(
      "runId must be a safe identifier of 1–120 characters beginning with a letter or number",
    );
  }
}

export type CouncilRunReservation = {
  runId: string;
  token: string;
  root: string;
  paths: CouncilArtifactPaths;
};

export function reserveCouncilRun(
  runId: string,
  runsRoot: string,
): CouncilRunReservation {
  assertCouncilRunId(runId);
  mkdirSync(runsRoot, { recursive: true });
  const root = realpathSync(runsRoot);
  const directory = join(root, runId);
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch {
    throw new Error(
      `council run already exists or cannot be reserved: ${runId}`,
    );
  }
  const reservation = {
    runId,
    token: randomUUID(),
    root,
    paths: {
      directory,
      manifest: join(directory, "manifest.json"),
      events: join(directory, "events.ndjson"),
      report: join(directory, "report.md"),
    },
  };
  writeFileSync(
    join(directory, "reservation.json"),
    JSON.stringify({ token: reservation.token }),
    { flag: "wx", mode: 0o600 },
  );
  return reservation;
}

function assertReservation(
  reservation: CouncilRunReservation,
  runId: string,
  runsRoot: string,
): void {
  assertCouncilRunId(runId);
  const directory = resolveRunDirectory(runId, runsRoot);
  if (
    reservation.runId !== runId ||
    reservation.root !== realpathSync(runsRoot) ||
    reservation.paths.directory !== directory
  )
    throw new Error("invalid council run reservation");
  const ownership = join(directory, "reservation.json");
  if (lstatSync(ownership).isSymbolicLink())
    throw new Error("unsafe council reservation");
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(ownership, "utf8"));
  } catch {
    throw new Error("invalid council reservation");
  }
  if (
    !record ||
    typeof record !== "object" ||
    !("token" in record) ||
    record.token !== reservation.token
  )
    throw new Error("council reservation ownership changed");
}

export function writeCouncilJobFailure(
  reservation: CouncilRunReservation,
  state: Record<string, unknown>,
): void {
  assertReservation(reservation, reservation.runId, reservation.root);
  writeFileSync(
    join(reservation.paths.directory, "terminal.json"),
    JSON.stringify(state),
    { flag: "wx", mode: 0o600 },
  );
}

export function resolveRunDirectory(runId: string, runsRoot: string): string {
  assertCouncilRunId(runId);
  const root = realpathSync(runsRoot);
  const directory = join(root, runId);
  if (
    lstatSync(directory).isSymbolicLink() ||
    !lstatSync(directory).isDirectory() ||
    dirname(realpathSync(directory)) !== root
  )
    throw new Error(
      "council run directory must remain inside the artifact root",
    );
  return directory;
}

export function listCouncilRunIds(runsRoot: string): string[] {
  if (!existsSync(runsRoot)) return [];
  return readdirSync(runsRoot).filter((id) => {
    try {
      resolveRunDirectory(id, runsRoot);
      return true;
    } catch {
      return false;
    }
  });
}

export function parseStoredRun(text: string): CouncilRun {
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
  if (typeof record.runId !== "string" || record.runId.length === 0) {
    throw new Error("stored council manifest has an invalid runId");
  }
  assertCouncilRunId(record.runId as string);
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
  // Bare names always identify runs. Explicit CLI paths require a separator.
  if (/[\\/]/.test(pathOrRunId) && existsSync(pathOrRunId)) {
    manifestPath = statSync(pathOrRunId).isDirectory()
      ? join(pathOrRunId, "manifest.json")
      : pathOrRunId;
  } else {
    assertCouncilRunId(pathOrRunId);
    manifestPath = join(
      resolveRunDirectory(pathOrRunId, runsRoot),
      "manifest.json",
    );
  }
  if (!existsSync(manifestPath)) {
    throw new Error(`council manifest not found: ${manifestPath}`);
  }
  if (
    lstatSync(manifestPath).isSymbolicLink() ||
    !lstatSync(manifestPath).isFile()
  )
    throw new Error("unsafe council manifest");
  const run = parseStoredRun(readFileSync(manifestPath, "utf8"));
  if (!/[\\/]/.test(pathOrRunId) && run.runId !== pathOrRunId)
    throw new Error("council manifest runId mismatch");
  return run;
}
