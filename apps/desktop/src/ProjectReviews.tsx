import type { JSX } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import { Field, Input, Select, Textarea } from "../../../docs/js/ds/Field";
import {
  CouncilVerdictStatus,
  verdictBead,
} from "../../../docs/js/islands/CouncilVerdictStatus";
import { estimateCouncilCost } from "../../../scripts/council/types";
import {
  type ProjectCouncilOriginalRead,
  type ProjectCouncilReserveRequest,
  type ProjectCouncilState,
  projectCouncilShownLabel,
  projectCouncilSourceChoiceSchema,
} from "../../../types/project-council";
import type { ProjectCouncilRunRead } from "../../../types/project-council-run-read";
import { KeeperMarkdown } from "./KeeperMarkdown";
import { beadHref } from "./ProjectBeads";
import {
  blankProjectCouncilDraft,
  type createProjectCouncilDraftCache,
  type ProjectCouncilDraft as Draft,
  type ProjectCouncilDraftScope,
} from "./project-council-draft";
import { useProjectCouncil } from "./use-project-council";

type SourceType = ProjectCouncilReserveRequest["sourceChoice"]["sourceType"];
function parseSourceType(value: string): SourceType | null {
  return value === "bead" ||
    value === "pr" ||
    value === "plan" ||
    value === "file" ||
    value === "text"
    ? value
    : null;
}
export function showCouncilControls(value: string): string {
  const characters = [...value];
  return characters
    .map((character, index) => {
      const point = character.codePointAt(0) ?? 0;
      if (
        character === "\n" ||
        character === "\t" ||
        (character === "\r" && characters[index + 1] === "\n")
      )
        return character;
      return /[\p{Cc}\p{Cf}\p{Cs}]/u.test(character)
        ? `<U+${point.toString(16).toUpperCase().padStart(4, "0")}>`
        : character;
    })
    .join("");
}

const showControls = showCouncilControls;

function OriginalReview({
  value,
}: {
  value: ProjectCouncilOriginalRead;
}): JSX.Element {
  const { original } = value;
  return (
    <section
      class="af-council-original"
      aria-label="Exact saved Council original"
    >
      <h3>Exact saved original</h3>
      <dl>
        <dt>Prepared review estimate</dt>
        <dd>
          ${estimateCouncilCost(original.profile).toFixed(4)} · maximum $
          {original.options.maxUsd.toFixed(2)}
        </dd>
        <dt>Source</dt>
        <dd>
          {projectCouncilShownLabel(original.context.source.displayName)} (
          {original.context.source.kind})
        </dd>
        <dt>Prepared bytes</dt>
        <dd>
          {original.context.byteLength.toLocaleString()} bytes
          {original.context.truncated
            ? "; the source was truncated as shown in the included material"
            : ""}
        </dd>
      </dl>
      <details>
        <summary>Request identity and scope</summary>
        <dl>
          <dt>Request</dt>
          <dd>
            <code>{original.requestId}</code>
          </dd>
          <dt>Intent hash</dt>
          <dd>
            <code>{original.intentHash}</code>
          </dd>
          <dt>Run</dt>
          <dd>
            <code>{original.runId}</code>
          </dd>
          <dt>Project scope</dt>
          <dd>
            {original.binding.projectId} · {original.binding.workspace} ·
            revision {original.binding.catalogRevision}
          </dd>
          <dt>Scope hash</dt>
          <dd>
            <code>{original.binding.scopeHash}</code>
          </dd>
          <dt>Prepared</dt>
          <dd>
            <time dateTime={original.createdAt}>
              {new Date(original.createdAt).toLocaleString()}
            </time>
          </dd>
        </dl>
      </details>
      <dl>
        <dt>Profile</dt>
        <dd>
          {projectCouncilShownLabel(original.profile.title)} ·{" "}
          {original.profile.depth} · estimated profile ceiling $
          {original.profile.maxEstimatedUsd.toFixed(2)}
        </dd>
        <dt>Budget</dt>
        <dd>
          ${original.options.maxUsd.toFixed(2)} ·{" "}
          {original.options.maxBytes.toLocaleString()} bytes
        </dd>
        <dt>Discussion</dt>
        <dd>
          {original.options.deepDiscussion
            ? "Deep discussion enabled"
            : "Standard discussion"}
        </dd>
        <dt>Secret policy</dt>
        <dd>
          {original.options.redactSecrets
            ? "Detected secrets redacted"
            : "Detected secrets rejected"}
        </dd>
        <dt>Redactions</dt>
        <dd>
          {original.context.redactions.length
            ? original.context.redactions
                .map(
                  (item) =>
                    `${projectCouncilShownLabel(item.kind)} ×${item.count}`,
                )
                .join(", ")
            : "None"}
        </dd>
      </dl>
      <h4>Review profile and seats</h4>
      <ul>
        {[...original.profile.seats, original.profile.chair].map((seat) => (
          <li key={seat.id}>
            {projectCouncilShownLabel(seat.role)}:{" "}
            {projectCouncilShownLabel(seat.provider)} /{" "}
            {projectCouncilShownLabel(seat.model)}
            {seat.openRouter
              ? ` · OpenRouter only ${seat.openRouter.only?.map(projectCouncilShownLabel).join(", ") ?? "any eligible"}; fallback ${seat.openRouter.allowFallbacks ? "enabled" : "disabled"}; collection ${seat.openRouter.dataCollection ?? "default"}; zero retention ${seat.openRouter.zeroDataRetention ? "on" : "off"}`
              : ""}
          </li>
        ))}
      </ul>
      <p>
        Quorum {original.profile.minQuorum}; peer ballots{" "}
        {original.profile.minPeerBallots}; discussion rounds{" "}
        {original.profile.maxDiscussionRounds ?? "profile default"}.
      </p>
      <h4>Provider endpoints</h4>
      <ul>
        {original.providerEndpoints.map((endpoint) => (
          <li key={endpoint.provider}>
            {projectCouncilShownLabel(endpoint.provider)}: {endpoint.transport}
            {endpoint.baseUrl ? ` · ${endpoint.baseUrl}` : ""}
          </li>
        ))}
      </ul>
      <h4>Included material</h4>
      <ul>
        {original.listing.map((item, index) => (
          <li key={`${index}:${item}`}>{showControls(item)}</li>
        ))}
      </ul>
      <details>
        <summary>Stored source reference and metadata</summary>
        <p>
          Reference:{" "}
          <code>{showControls(original.context.source.locator)}</code>
        </p>
        {original.context.source.metadata ? (
          <pre>
            {showControls(
              JSON.stringify(original.context.source.metadata, null, 2),
            )}
          </pre>
        ) : null}
      </details>
      {original.context.evidence.map((item) => (
        <article class="af-council-evidence" key={item.id}>
          <h4>{showControls(item.title)}</h4>
          <KeeperMarkdown text={showControls(item.content)} />
        </article>
      ))}
      <p class="af-muted">
        Review the exact saved bytes above. This view does not start a review.
      </p>
      <p>
        <small>
          Request identity and original hash are verified in memory.
        </small>
      </p>
    </section>
  );
}

type CouncilResultPhase = Extract<
  ProjectCouncilState,
  "completed" | "failed" | "cancelled"
>;
type CouncilResultFacts = {
  requestId: string;
  intentHash: string;
  runId: string;
  projectId: string;
  workspace: string;
  phase: CouncilResultPhase;
  recommendation: "pass" | "needs_changes" | "insufficient_evidence" | null;
  severities: Record<"blocker" | "high" | "medium" | "low", number>;
  actualCostUsd: number | null;
  accountedCostUsd: number;
  costIsEstimate: boolean;
  durationSeconds: number | null;
  beadId: string | null;
};
type CouncilSeverity = keyof CouncilResultFacts["severities"];
type VerifiedCouncilResult = {
  facts: CouncilResultFacts;
  job: NonNullable<ProjectCouncilRunRead["job"]>;
};

type CouncilProgressJob = {
  status: string;
  events: readonly {
    type: string;
    payload?: Record<string, unknown>;
  }[];
};
export function projectCouncilProgressView(
  receiptPhase: string | null | undefined,
  job: CouncilProgressJob | null | undefined,
): { active: boolean; label: string | null; stopPending: boolean } {
  const active =
    receiptPhase === "running" &&
    (job?.status === "running" || job?.status === "cancelling");
  if (!active || !job)
    return { active: false, label: null, stopPending: false };
  if (job.status === "cancelling")
    return {
      active: true,
      label: "Stop requested; waiting for a verified saved result",
      stopPending: true,
    };
  const latest = [...job.events]
    .reverse()
    .find(
      (event) =>
        event.type === "stage.started" || event.type === "stage.completed",
    );
  const round = latest?.payload?.round;
  const discussionLabel =
    typeof round === "number" && Number.isSafeInteger(round) && round >= 0
      ? `Discussing round ${round}`
      : "Discussing (number not recorded)";
  const label =
    latest?.type === "stage.started"
      ? latest.payload?.stage === "independent"
        ? "Reviewing"
        : latest.payload?.stage === "peer" ||
            latest.payload?.stage === "revision"
          ? discussionLabel
          : latest.payload?.stage === "chair"
            ? "Synthesizing"
            : "Checking saved progress"
      : latest?.type === "stage.completed"
        ? "Checking next stage"
        : job.events.some((event) => event.type === "run.started")
          ? "Queued"
          : "Checking saved progress";
  return { active, label, stopPending: false };
}

type CouncilProgressEvent = {
  type: string;
  payload?: Record<string, unknown>;
};
type CouncilRosterSeat = { id: string; role: string };
export function projectCouncilLiveReviewView<T>(
  liveRounds: readonly T[] | undefined,
  savedRounds: readonly T[] | undefined,
  jobRoster: readonly CouncilRosterSeat[] | undefined,
  originalRoster: readonly CouncilRosterSeat[] | undefined,
  events: readonly CouncilProgressEvent[],
): {
  rounds: readonly T[];
  rosterKnown: boolean;
  seats: readonly { seatId: string; role: string; state: string }[];
} {
  const roster = jobRoster ?? originalRoster;
  const states = new Map(
    (roster ?? []).map((seat) => [seat.id, { role: seat.role, state: "Pending" }]),
  );
  let stage: { name: string; round?: unknown } | null = null;
  for (const event of events) {
    if (event.type === "stage.started") {
      const name = event.payload?.stage;
      stage = typeof name === "string" ? { name, round: event.payload?.round } : null;
      for (const [seatId, seat] of states)
        if (seat.state !== "Failed" && seat.state !== "Cancelled")
          states.set(seatId, { ...seat, state: "Pending" });
      continue;
    }
    if (event.type === "stage.completed") {
      stage = null;
      continue;
    }
    const seatId = event.payload?.seatId;
    if (typeof seatId !== "string" || !states.has(seatId)) continue;
    const seat = states.get(seatId);
    if (!seat) continue;
    let state = seat.state;
    if (event.type === "seat.failed") state = "Failed";
    else if (event.type === "seat.cancelled") state = "Cancelled";
    else if (event.type === "seat.completed") state = "Complete";
    else if (event.type === "seat.started") {
      const name = event.payload?.stage;
      state =
        name === "independent"
          ? "Reviewing"
          : name === "chair"
            ? "Synthesizing"
            : name === "peer" || name === "revision"
              ? stage?.name === name &&
                typeof stage.round === "number" &&
                Number.isSafeInteger(stage.round) &&
                stage.round >= 0
                ? `Discussing round ${stage.round}`
                : "Discussing (number not recorded)"
              : "Checking saved progress";
    }
    states.set(seatId, { ...seat, state });
  }
  return {
    rounds: liveRounds ?? savedRounds ?? [],
    rosterKnown: roster !== undefined,
    seats: [...states].map(([seatId, seat]) => ({ seatId, ...seat })),
  };
}

type CouncilJobRead = NonNullable<ProjectCouncilRunRead["job"]>;
type CouncilDiscussionRound = NonNullable<
  NonNullable<CouncilJobRead["run"]>["discussion"]
>[number];

function CouncilDiscussionView({
  rounds,
}: {
  rounds: readonly CouncilDiscussionRound[];
}): JSX.Element {
  const [selectedRound, setSelectedRound] = useState(0);
  const discussion = rounds[selectedRound];
  return (
    <section aria-label="Council discussion">
      <h4>Discussion</h4>
      <label>
        Round{" "}
        <select
          value={selectedRound}
          onChange={(event) =>
            setSelectedRound(Number(event.currentTarget.value))
          }
        >
          {rounds.map((round, index) => (
            <option key={`${round.stage}:${round.round ?? index}`} value={index}>
              {round.stage}
              {round.round === undefined ? "" : ` ${round.round}`}
            </option>
          ))}
        </select>
      </label>
      {discussion ? (
        <>
          <ul>
            {discussion.records.map((record, index) => (
              <li key={`${record.seatId}:${index}`}>
                <strong>
                  {showControls(record.seatId)} · {record.status}
                </strong>
                {record.error ? <p>{showControls(record.error)}</p> : null}
                {record.output && "findings" in record.output ? (
                  <section>
                    <p>Verdict: {record.output.verdict}</p>
                    {record.output.findings.map((item, itemIndex) => (
                      <article key={`${record.seatId}:finding:${itemIndex}`}>
                        <h5>
                          {showControls(item.title)} · {item.severity}
                        </h5>
                        <KeeperMarkdown text={showControls(item.claim)} />
                        <p>{showControls(item.consequence)}</p>
                      </article>
                    ))}
                    <ul>
                      {record.output.strengths.map((item, itemIndex) => (
                        <li key={`${record.seatId}:strength:${itemIndex}`}>
                          <KeeperMarkdown text={showControls(item)} />
                        </li>
                      ))}
                    </ul>
                    <ul>
                      {record.output.unknowns.map((item, itemIndex) => (
                        <li key={`${record.seatId}:unknown:${itemIndex}`}>
                          <KeeperMarkdown text={showControls(item)} />
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                {record.output && "ballots" in record.output ? (
                  <ul>
                    {record.output.ballots.map((ballot, ballotIndex) => (
                      <li key={`${record.seatId}:ballot:${ballotIndex}`}>
                        <strong>
                          {ballot.stance} · {showControls(ballot.candidateId)}
                        </strong>
                        : <KeeperMarkdown text={showControls(ballot.reason)} />
                      </li>
                    ))}
                    {record.output.missingFindings.map((item, itemIndex) => (
                      <li key={`${record.seatId}:missing:${itemIndex}`}>
                        <strong>
                          Additional finding · {item.severity}: {showControls(item.title)}
                        </strong>
                        <KeeperMarkdown text={showControls(item.claim)} />
                      </li>
                    ))}
                  </ul>
                ) : null}
                {record.output && "summary" in record.output ? (
                  <>
                    <KeeperMarkdown text={showControls(record.output.summary)} />
                    <ul>
                      {record.output.recommendations.map((item, itemIndex) => (
                        <li key={`${record.seatId}:recommendation:${itemIndex}`}>
                          <KeeperMarkdown text={showControls(item)} />
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {record.output ? (
                  <details>
                    <summary>Inspect structured seat response</summary>
                    <pre>{showControls(JSON.stringify(record.output, null, 2))}</pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
          {discussion.findings.map((finding) => (
            <article key={finding.key}>
              <h5>
                {showControls(finding.title)} · {finding.resolution}
              </h5>
              <KeeperMarkdown text={showControls(finding.claim)} />
            </article>
          ))}
        </>
      ) : null}
    </section>
  );
}

function verifiedCouncilResult(
  original: ProjectCouncilOriginalRead | null,
  value: ProjectCouncilRunRead | null,
  projectId: string,
  workspace: string | null,
  phase: string,
): VerifiedCouncilResult | null {
  if (
    !original ||
    !value ||
    !workspace ||
    (phase !== "completed" && phase !== "failed" && phase !== "cancelled")
  )
    return null;
  const saved = original.original;
  const { provenance, receipt, job } = value;
  const run = job?.run;
  if (
    !job ||
    !run ||
    receipt.phase !== phase ||
    saved.state !== phase ||
    original.metadata.projectId !== projectId ||
    original.metadata.requestId !== saved.requestId ||
    original.metadata.intentHash !== saved.intentHash ||
    saved.binding.projectId !== projectId ||
    saved.binding.workspace !== workspace ||
    provenance.projectId !== projectId ||
    provenance.workspace !== workspace ||
    provenance.requestId !== saved.requestId ||
    provenance.intentHash !== saved.intentHash ||
    provenance.runId !== saved.runId ||
    provenance.catalogRevision !== saved.binding.catalogRevision ||
    provenance.scopeHash !== saved.binding.scopeHash ||
    receipt.metadata.requestId !== saved.requestId ||
    receipt.metadata.intentHash !== saved.intentHash ||
    receipt.metadata.runId !== saved.runId ||
    receipt.metadata.projectId !== projectId ||
    receipt.metadata.state !== saved.state ||
    job.runId !== saved.runId ||
    job.status !== phase ||
    run.runId !== saved.runId ||
    run.status !== phase
  )
    return null;
  const started = Date.parse(run.startedAt);
  const finished = Date.parse(run.finishedAt);
  const severity = (name: CouncilSeverity) =>
    run.aggregatedFindings.filter((finding) => finding.severity === name)
      .length;
  return {
    job,
    facts: {
      requestId: saved.requestId,
      intentHash: saved.intentHash,
      runId: saved.runId,
      projectId,
      workspace,
      phase,
      recommendation:
        phase === "completed" ? (run.chair?.verdict ?? null) : null,
      severities: {
        blocker: severity("blocker"),
        high: severity("high"),
        medium: severity("medium"),
        low: severity("low"),
      },
      actualCostUsd: run.actualCostUsd,
      accountedCostUsd: run.accountedCostUsd,
      costIsEstimate: run.costIsEstimate,
      durationSeconds:
        Number.isFinite(started) &&
        Number.isFinite(finished) &&
        finished >= started
          ? Math.floor((finished - started) / 1000)
          : null,
      beadId: verdictBead(job),
    },
  };
}

function CouncilResultFactsPanel({
  facts,
  projectId,
  job,
  showCommentStatus,
}: {
  facts: CouncilResultFacts;
  projectId: string;
  job?: VerifiedCouncilResult["job"];
  showCommentStatus?: boolean;
}): JSX.Element {
  return (
    <section aria-label="Verified result facts">
      <h4>Verified result facts · {facts.phase}</h4>
      <dl>
        {facts.recommendation && (
          <>
            <dt>Recommendation</dt>
            <dd>
              {facts.recommendation === "pass"
                ? "Pass"
                : facts.recommendation === "needs_changes"
                  ? "Changes needed"
                  : "Insufficient evidence"}
            </dd>
          </>
        )}
        <dt>Findings by severity</dt>
        <dd>
          {(["blocker", "high", "medium", "low"] as const)
            .map((severity) => `${severity}: ${facts.severities[severity]}`)
            .join(" · ")}
        </dd>
        <dt>Actual cost</dt>
        <dd>
          {facts.actualCostUsd === null
            ? "Not recorded"
            : `$${facts.actualCostUsd.toFixed(4)}`}
        </dd>
        <dt>Accounted cost</dt>
        <dd>
          ${facts.accountedCostUsd.toFixed(4)}
          {facts.costIsEstimate ? " (estimate)" : ""}
        </dd>
        <dt>Duration</dt>
        <dd>
          {facts.durationSeconds === null
            ? "Not recorded"
            : facts.durationSeconds < 60
              ? `${facts.durationSeconds} seconds`
              : `${Math.floor(facts.durationSeconds / 60)} minutes`}
        </dd>
      </dl>
      {facts.beadId && (
        <>
          <a href={beadHref(projectId, facts.beadId, true)}>
            Open reviewed bead {facts.beadId}
          </a>
          {showCommentStatus && job && (
            <CouncilVerdictStatus
              key={`${job.runId}:${job.startedAt}:${facts.beadId}`}
              job={job}
              bead={facts.beadId}
            />
          )}
        </>
      )}
    </section>
  );
}

function RunReview({
  value,
  verifiedResult,
  originalProfile,
  projectId,
  loading,
  canCancel,
  requestId,
  intentHash,
  onRead,
  onCancel,
}: {
  value: ProjectCouncilRunRead | null;
  verifiedResult: VerifiedCouncilResult | null;
  originalProfile: ProjectCouncilOriginalRead["original"]["profile"];
  projectId: string;
  loading: boolean;
  canCancel: boolean;
  requestId: string;
  intentHash: string;
  onRead(): void;
  onCancel(requestId: string, intentHash: string): void;
}): JSX.Element {
  const receipt = value?.receipt;
  const job = value?.job;
  const run = job?.run;
  const progress = projectCouncilProgressView(receipt?.phase, job);
  const active = progress.active;
  const events = job?.events ?? [];
  const stageLabel = progress.label;
  const roster = (profile: typeof originalProfile | undefined) =>
    profile
      ? [...profile.seats, profile.chair].map(({ id, role }) => ({ id, role }))
      : undefined;
  const liveReview = projectCouncilLiveReviewView(
    job?.discussion,
    run?.discussion,
    roster(job?.profile),
    roster(originalProfile),
    events,
  );
  const rounds = run ? (run.discussion ?? []) : liveReview.rounds;
  const terminal =
    receipt?.phase === "completed" ||
    receipt?.phase === "failed" ||
    receipt?.phase === "cancelled";
  return (
    <section aria-label="Council result and progress">
      <h3>
        {receipt?.phase === "completed"
          ? "Council result"
          : receipt?.phase === "failed"
            ? "Council failed"
            : receipt?.phase === "cancelled"
              ? "Council cancelled"
              : receipt?.phase === "running"
                ? "Council in progress"
                : "Council status"}
      </h3>
      {receipt ? (
        <p role="status">
          Verified state: {receipt.phase}
          {job ? ` · ${job.status}` : ""}
          {job?.persistenceStatus
            ? ` · result persistence ${job.persistenceStatus}`
            : ""}
          {active ? ` · ${stageLabel}` : ""}
        </p>
      ) : (
        <p>Run status has not been read.</p>
      )}
      {verifiedResult && (
        <CouncilResultFactsPanel
          facts={verifiedResult.facts}
          projectId={projectId}
          job={verifiedResult.job}
          showCommentStatus
        />
      )}
      {job?.error || receipt?.error ? (
        <p role="alert">{showControls(job?.error ?? receipt?.error ?? "")}</p>
      ) : null}
      {run ? (
        <>
          {run.chair && receipt?.phase === "completed" ? (
            <section
              aria-label="Council recommendation"
              class="af-council-recommendation"
            >
              <h4>
                {run.chair.verdict === "pass"
                  ? "Recommendation: Pass"
                  : run.chair.verdict === "needs_changes"
                    ? "Recommendation: Changes needed"
                    : "Recommendation: Insufficient evidence"}
              </h4>
              <KeeperMarkdown text={showControls(run.chair.summary)} />
              {run.chair.recommendations.length ? (
                <ul>
                  {run.chair.recommendations.map((item, index) => (
                    <li key={index}>
                      <KeeperMarkdown text={showControls(item)} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
          <dl>
            <dt>Started</dt>
            <dd>
              <time dateTime={run.startedAt}>
                {new Date(run.startedAt).toLocaleString()}
              </time>
            </dd>
            <dt>Finished</dt>
            <dd>
              <time dateTime={run.finishedAt}>
                {new Date(run.finishedAt).toLocaleString()}
              </time>
            </dd>
            <dt>Actual cost</dt>
            <dd>
              {run.actualCostUsd === null
                ? "Not recorded"
                : `$${run.actualCostUsd.toFixed(4)}`}
            </dd>
            <dt>Accounted cost</dt>
            <dd>
              ${run.accountedCostUsd.toFixed(4)}
              {run.costIsEstimate ? " (estimate)" : ""}
            </dd>
            <dt>Usage estimate</dt>
            <dd>
              {run.usageEstimatedCostUsd === null
                ? "Not recorded"
                : `$${run.usageEstimatedCostUsd.toFixed(4)}`}
            </dd>
            <dt>Findings</dt>
            <dd>{run.aggregatedFindings.length}</dd>
          </dl>
          {run.aggregatedFindings.length ? (
            <section aria-label="Council findings">
              <h4>Findings</h4>
              <ol>
                {run.aggregatedFindings.map((finding) => (
                  <li key={finding.key}>
                    <h5>
                      {showControls(finding.title)} · {finding.severity} ·{" "}
                      {finding.resolution}
                      {finding.contested ? " · contested" : ""}
                    </h5>
                    <KeeperMarkdown text={showControls(finding.claim)} />
                    <p>
                      <strong>Consequence:</strong>{" "}
                      {showControls(finding.consequence)}
                    </p>
                    <p>
                      {finding.support} support · {finding.oppose} oppose ·{" "}
                      {finding.uncertain} uncertain
                      {finding.severityDisputed ? " · severity disputed" : ""}
                    </p>
                    {finding.rationales.length ? (
                      <ul>
                        {finding.rationales.map((rationale, index) => (
                          <li key={`${finding.key}:${index}`}>
                            <strong>
                              {showControls(rationale.reviewerLabel)} ·{" "}
                              {rationale.stance}
                            </strong>
                            :{" "}
                            <KeeperMarkdown
                              text={showControls(rationale.reason)}
                            />
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}
          {run.limitations.length || run.failures.length ? (
            <section aria-label="Limitations and failures">
              <h4>Limitations and failures</h4>
              {run.limitations.length ? (
                <ul>
                  {run.limitations.map((item, index) => (
                    <li key={`limit:${index}`}>
                      <KeeperMarkdown text={showControls(item)} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {run.failures.length ? (
                <ul>
                  {run.failures.map((failure, index) => (
                    <li key={`failure:${index}`}>
                      {failure.stage} · {showControls(failure.seatId)}:{" "}
                      {showControls(failure.error)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
          {run.records.some(
            (record) =>
              record.output &&
              ("strengths" in record.output || "unknowns" in record.output),
          ) ? (
            <section aria-label="Strengths and unknowns">
              <h4>Strengths and unknowns</h4>
              {run.records.flatMap((record) =>
                record.output && "strengths" in record.output
                  ? record.output.strengths.map((item, index) => (
                      <p key={`${record.seatId}:strength:${index}`}>
                        <strong>Strength:</strong>{" "}
                        <KeeperMarkdown text={showControls(item)} />
                      </p>
                    ))
                  : [],
              )}
              {run.records.flatMap((record) =>
                record.output && "unknowns" in record.output
                  ? record.output.unknowns.map((item, index) => (
                      <p key={`${record.seatId}:unknown:${index}`}>
                        <strong>Unknown:</strong>{" "}
                        <KeeperMarkdown text={showControls(item)} />
                      </p>
                    ))
                  : [],
              )}
            </section>
          ) : null}
          {rounds.length ? <CouncilDiscussionView rounds={rounds} /> : null}
          {receipt?.phase !== "completed" ? (
            <p role="status">
              Partial records are shown below. No final recommendation is
              inferred for a failed or cancelled run.
            </p>
          ) : null}
          <details>
            <summary>Inspect complete public Council result</summary>
            <textarea
              class="af-council-transcript"
              aria-label="Complete public Council result transcript"
              readOnly
              rows={18}
              value={showControls(JSON.stringify(run, null, 2))}
            />
          </details>
        </>
      ) : null}
      {job && !run ? (
        <>
          {liveReview.rounds.length ? (
            <CouncilDiscussionView rounds={liveReview.rounds} />
          ) : null}
          <section aria-label="Council progress">
            <h4>{stageLabel ?? "Checking saved progress"}</h4>
            {liveReview.rosterKnown ? (
              <ul>
                {liveReview.seats.map((seat) => (
                  <li key={seat.seatId}>
                    {showControls(seat.role)} · {showControls(seat.seatId)} · {seat.state}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Seat roster and individual pending states are unknown.</p>
            )}
            <details>
              <summary>Inspect verified progress events</summary>
              <ol>
                {events.slice(-40).map((event, index) => (
                  <li key={`${event.type}:${index}`}>
                    <time dateTime={event.at}>
                      {new Date(event.at).toLocaleTimeString()}
                    </time>{" "}
                    · {event.type} ·{" "}
                    <code>{showControls(JSON.stringify(event.payload))}</code>
                  </li>
                ))}
              </ol>
            </details>
          </section>
        </>
      ) : null}
      {terminal ? (
        <p class="af-muted">
          The exact original remains available above; this result is read from
          the saved run.
        </p>
      ) : null}
      <div class="af-button-row">
        <Button onClick={onRead} disabled={loading}>
          {loading ? "Checking saved result…" : "Check saved result"}
        </Button>
        {active ? (
          <Button
            onClick={() => onCancel(requestId, intentHash)}
            disabled={loading || !canCancel || progress.stopPending}
          >
            {progress.stopPending ? "Stop requested" : "Stop review"}
          </Button>
        ) : null}
        {active && progress.stopPending ? (
          <span>
            Waiting for a verified saved result before reporting cancellation.
          </span>
        ) : active && !canCancel ? (
          <span>
            Read the saved result to confirm the current state before requesting
            another action.
          </span>
        ) : null}
      </div>
      {active ? (
        <p role="status">
          {progress.stopPending
            ? progress.label
            : "Progress refreshes while this view is open. Stop requests cancellation; the saved result is checked before cancellation is reported."}
        </p>
      ) : null}
    </section>
  );
}

export function ProjectReviews({
  projectId,
  workspace,
  archived,
  writesAllowed,
  draftCache,
  draftGeneration,
  focusSource,
}: {
  projectId: string;
  workspace: string | null;
  archived: boolean;
  writesAllowed: boolean;
  draftCache: ReturnType<typeof createProjectCouncilDraftCache> | null;
  draftGeneration: number;
  focusSource: boolean;
}): JSX.Element {
  const { owner, view } = useProjectCouncil(projectId, workspace);
  const focusedDraftGeneration = useRef<number | null>(null);
  const scope: ProjectCouncilDraftScope | null = workspace
    ? { projectId, workspace }
    : null;
  const [draft, setDraft] = useState<Draft>(() =>
    scope
      ? (draftCache?.read(scope)?.draft ?? blankProjectCouncilDraft())
      : blankProjectCouncilDraft(),
  );
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftCacheError, setDraftCacheError] = useState("");
  const [filter, setFilter] = useState("");
  const [historyFacts, setHistoryFacts] = useState<
    Map<string, CouncilResultFacts>
  >(() => new Map());
  const [historyFactsLimitReached, setHistoryFactsLimitReached] =
    useState(false);
  useEffect(() => {
    if (!workspace || !draftCache) return;
    const current = draftCache.read({ projectId, workspace });
    if (current) {
      setDraft(current.draft);
      setDraftOpen(true);
    } else if (draftGeneration > 0) {
      setDraft(blankProjectCouncilDraft());
      setDraftOpen(true);
    }
  }, [draftGeneration, draftCache, projectId, workspace]);
  useEffect(() => {
    if (
      !focusSource ||
      !draftOpen ||
      !view ||
      view.phase === "loading" ||
      focusedDraftGeneration.current === draftGeneration
    )
      return;
    const sourceInput = document.getElementById("council-source");
    if (sourceInput) {
      sourceInput.focus();
      focusedDraftGeneration.current = draftGeneration;
    }
  }, [draftGeneration, focusSource, draftOpen, view?.phase]);
  const profile =
    view?.profiles.find((choice) => choice.path === draft.profileChoice) ??
    view?.profiles[0];
  const ready =
    !!profile && profile.readiness.every((entry) => entry.configured);
  const source = projectCouncilSourceChoiceSchema.safeParse({
    sourceType: draft.sourceType,
    source: draft.source,
  });
  const amountsValid =
    draft.maxUsd.trim() !== "" &&
    Number.isFinite(Number(draft.maxUsd)) &&
    Number(draft.maxUsd) >= 0 &&
    Number(draft.maxUsd) <= 1_000_000 &&
    Number.isInteger(Number(draft.maxBytes)) &&
    Number(draft.maxBytes) > 0 &&
    Number(draft.maxBytes) <= 1_048_576;
  const sourceError = source.success
    ? ""
    : draft.source.trim() === ""
      ? "Enter a source before preparing the original."
      : "This source is too long or invalid for the selected source type.";
  const amountError = amountsValid
    ? ""
    : "Enter a nonnegative cost limit and a whole-byte limit from 1 to 1,048,576.";
  const canPrepare =
    !!owner &&
    !!workspace &&
    writesAllowed &&
    !archived &&
    view?.phase === "ready" &&
    ready &&
    source.success &&
    amountsValid;
  const update = (patch: Partial<Draft>) => {
    const updated = { ...draft, ...patch };
    if (!scope || !draftCache) {
      setDraftCacheError(
        "A current served project workspace is required before editing a private Council draft.",
      );
      return;
    }
    const saved = draftCache.write(scope, updated);
    if (saved.kind !== "saved") {
      setDraftCacheError(
        saved.reason === "capacity"
          ? "The 32-draft limit is reached. Existing drafts are preserved."
          : saved.reason === "source-too-large"
            ? "This source is too large for the private in-memory draft cache."
            : "This project workspace is no longer available for the draft.",
      );
      return;
    }
    setDraft(saved.draft);
    setDraftCacheError("");
  };
  const prepare = () => {
    if (!owner || !profile || !canPrepare || !source.success) return;
    const request: ProjectCouncilReserveRequest = {
      sourceChoice: source.data,
      profileChoice: profile.path,
      maxUsd: Number(draft.maxUsd),
      maxBytes: Number(draft.maxBytes),
      redactSecrets: draft.redactSecrets,
      deepDiscussion: draft.deepDiscussion,
    };
    void owner.prepare(request);
  };
  const selectedReady = profile?.readiness ?? [];
  const activeRequestId = view?.history?.activeRequestId ?? null;
  const openedRequestId = view?.original?.original.requestId ?? null;
  const historyItems =
    view?.history?.items.filter((item) => {
      const needle = filter.trim().toLocaleLowerCase();
      return (
        !needle ||
        [item.sourceName, item.profileTitle, item.requestId, item.state].some(
          (value) => value.toLocaleLowerCase().includes(needle),
        )
      );
    }) ?? [];
  const selectedResult = useMemo(
    () =>
      verifiedCouncilResult(
        view?.original ?? null,
        view?.run ?? null,
        projectId,
        workspace,
        view?.phase ?? "loading",
      ),
    [view?.original, view?.run, view?.phase, projectId, workspace],
  );
  useEffect(() => {
    const history = view?.history;
    if (
      !workspace ||
      !history ||
      history.projectId !== projectId ||
      history.workspace !== workspace
    ) {
      if (historyFactsLimitReached) setHistoryFactsLimitReached(false);
      return;
    }
    const matches = (facts: CouncilResultFacts) =>
      facts.projectId === projectId &&
      facts.workspace === workspace &&
      history.items.some(
        (item) =>
          item.requestId === facts.requestId &&
          item.intentHash === facts.intentHash &&
          item.runId === facts.runId &&
          item.phase === facts.phase,
      );
    const next = new Map(
      [...historyFacts].filter(([, facts]) => matches(facts)),
    );
    if (next.size < 100 && historyFactsLimitReached)
      setHistoryFactsLimitReached(false);
    const facts = selectedResult?.facts;
    const rowMatches =
      facts !== undefined &&
      history.items.some(
        (item) =>
          item.requestId === facts.requestId &&
          item.intentHash === facts.intentHash &&
          item.runId === facts.runId &&
          item.phase === facts.phase,
      );
    if (facts && rowMatches) {
      if (!next.has(facts.requestId) && next.size >= 100) {
        setHistoryFactsLimitReached(true);
      } else {
        next.set(facts.requestId, facts);
        setHistoryFactsLimitReached(false);
      }
    }
    const changed =
      next.size !== historyFacts.size ||
      [...next].some(
        ([requestId, summary]) =>
          JSON.stringify(historyFacts.get(requestId)) !==
          JSON.stringify(summary),
      );
    if (changed) setHistoryFacts(next);
  }, [
    historyFacts,
    historyFactsLimitReached,
    projectId,
    selectedResult,
    view?.history,
    workspace,
  ]);
  return (
    <section class="af-project-reviews" aria-label="Council reviews">
      <header>
        <div>
          <h2>Council reviews</h2>
          <p>
            Prepare and inspect a saved original before any review is started.
          </p>
        </div>
        <Button
          onClick={() => {
            if (owner) void owner.refresh();
          }}
          disabled={
            !owner ||
            view?.phase === "loading" ||
            view?.phase === "preparing" ||
            view?.phase === "retiring"
          }
        >
          Check saved reviews
        </Button>
      </header>
      {!view || view.phase === "loading" ? (
        <p role="status">Loading saved Council reviews…</p>
      ) : null}
      {view?.error ? <p role="alert">{view.error}</p> : null}
      {view?.phase === "held" && !view.original ? (
        <div role="alert">
          <h3>
            {view.history?.activeRequestId
              ? "Active saved review needs confirmation"
              : "Saved review status is unknown"}
          </h3>
          <p>
            {view.history?.activeRequestId
              ? "A canonical request is active. Read its exact protected original before continuing."
              : "The request may have been saved. Keep it held while the protected saved-review record is checked."}
          </p>
          <Button
            onClick={() => {
              if (!owner) return;
              if (activeRequestId) void owner.openSaved(activeRequestId);
              else void owner.refresh();
            }}
          >
            {activeRequestId ? "Read saved original" : "Check saved reviews"}
          </Button>
        </div>
      ) : null}
      {view?.original ? (
        <>
          {["completed", "failed", "cancelled"].includes(
            view.original.original.state,
          ) ? (
            <details>
              <summary>Show exact saved original</summary>
              <OriginalReview value={view.original} />
            </details>
          ) : (
            <OriginalReview value={view.original} />
          )}
          {view.phase === "reserved" &&
          view.original.original.state === "reserved" ? (
            <div class="af-button-row">
              <Button
                variant="primary"
                onClick={() => {
                  const requestId = view.original?.original.requestId;
                  const intentHash = view.original?.original.intentHash;
                  if (owner && requestId && intentHash)
                    void owner.convene(requestId, intentHash);
                }}
                disabled={!writesAllowed || archived || !workspace}
              >
                Convene this exact original
              </Button>
              <Button
                onClick={() => {
                  const requestId = view.original?.original.requestId;
                  const intentHash = view.original?.original.intentHash;
                  if (owner && requestId && intentHash)
                    void owner.retire(requestId, intentHash);
                }}
                disabled={!writesAllowed || archived}
              >
                Retire saved original
              </Button>
              <span>
                Retiring is available only while this verified original is still
                reserved.
              </span>
            </div>
          ) : view.phase === "held" &&
            view.original.original.state === "reserved" ? (
            <>
              <p role="status">
                The last read showed a reserved original, but the latest action
                state is not confirmed. Read the canonical original again before
                continuing.
              </p>
              <Button
                onClick={() => {
                  if (owner && openedRequestId)
                    void owner.openSaved(openedRequestId);
                }}
              >
                Read saved original
              </Button>
            </>
          ) : (
            <>
              <p role="status">
                This original is {view.original.original.state}; its identity
                and contents remain available for explicit recovery.
              </p>
              {view.original.original.state !== "retired" ? (
                <RunReview
                  value={view.run}
                  verifiedResult={selectedResult}
                  originalProfile={view.original.original.profile}
                  projectId={projectId}
                  loading={view.runLoading}
                  canCancel={
                    view.phase === "running" &&
                    writesAllowed &&
                    !archived &&
                    !!workspace
                  }
                  requestId={view.original.original.requestId}
                  intentHash={view.original.original.intentHash}
                  onRead={() => {
                    if (owner) void owner.readRun();
                  }}
                  onCancel={(requestId, intentHash) => {
                    if (owner) void owner.cancel(requestId, intentHash);
                  }}
                />
              ) : null}
              {view.history &&
                view.history.total > 0 &&
                view.history.activeRequestId === null &&
                (view.original.original.state === "completed" ||
                  view.original.original.state === "failed" ||
                  view.original.original.state === "cancelled" ||
                  view.original.original.state === "retired") && (
                  <Button
                    onClick={() => {
                      owner?.newDraft();
                      setDraftOpen(false);
                    }}
                  >
                    Back to saved reviews
                  </Button>
                )}
              {view.history?.activeRequestId === null &&
              (view.original.original.state === "completed" ||
                view.original.original.state === "failed" ||
                view.original.original.state === "cancelled" ||
                view.original.original.state === "retired") ? (
                <Button
                  onClick={() => {
                    owner?.newDraft();
                    setDraftOpen(true);
                  }}
                >
                  New review
                </Button>
              ) : null}
            </>
          )}
        </>
      ) : view?.phase !== "held" && view?.phase !== "loading" ? (
        activeRequestId ? (
          <section aria-label="Active saved review">
            <h3>Active saved review</h3>
            <p>
              Request <code>{activeRequestId}</code> is active. Its private
              contents load only when you select the protected read.
            </p>
            <Button
              onClick={() => {
                if (owner) void owner.openSaved(activeRequestId);
              }}
            >
              Read saved original
            </Button>
          </section>
        ) : (
          <>
            {view?.history && view.history.total > 0 ? (
              <section aria-label="Saved review history">
                <h3>Saved reviews</h3>
                <p>
                  {view.history.total} saved review
                  {view.history.total === 1 ? "" : "s"}
                  {view.history.omitted
                    ? `; ${view.history.omitted} older entries omitted`
                    : ""}
                  . Open a row to read its private original. Verified result
                  facts and Bead comment status appear only after the exact
                  protected result is read.
                </p>
                <Field label="Filter saved reviews" id="council-history-filter">
                  <Input
                    id="council-history-filter"
                    type="search"
                    value={filter}
                    onInput={(event) => setFilter(event.currentTarget.value)}
                  />
                </Field>
                {filter ? (
                  <Button onClick={() => setFilter("")}>Clear filters</Button>
                ) : null}
                {historyFactsLimitReached && (
                  <p role="status">
                    The 100-row summary cache is full. Open a result again to
                    see its verified facts.
                  </p>
                )}
                <ul>
                  {historyItems.map((item) => {
                    const cached = historyFacts.get(item.requestId);
                    const facts =
                      cached &&
                      cached.projectId === projectId &&
                      cached.workspace === workspace &&
                      cached.requestId === item.requestId &&
                      cached.intentHash === item.intentHash &&
                      cached.runId === item.runId &&
                      cached.phase === item.phase
                        ? cached
                        : null;
                    return (
                      <li key={item.requestId}>
                        <strong>
                          {projectCouncilShownLabel(item.sourceName)}
                        </strong>{" "}
                        · {projectCouncilShownLabel(item.profileTitle)} ·{" "}
                        {item.phase} ·{" "}
                        <time dateTime={item.updatedAt}>
                          {new Date(item.updatedAt).toLocaleString()}
                        </time>
                        <Button
                          onClick={() => {
                            if (!owner) return;
                            if (
                              item.phase !== "reserved" &&
                              item.phase !== "retired"
                            )
                              void owner.openResult(item.requestId);
                            else void owner.openSaved(item.requestId);
                          }}
                        >
                          {item.phase !== "reserved" && item.phase !== "retired"
                            ? "Open result"
                            : "Read saved original"}
                        </Button>
                        {facts ? (
                          <CouncilResultFactsPanel
                            facts={facts}
                            projectId={projectId}
                          />
                        ) : item.phase === "completed" ||
                          item.phase === "failed" ||
                          item.phase === "cancelled" ? (
                          <p>
                            Open this result to read verified facts and Bead
                            comment status.
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                {historyItems.length === 0 ? (
                  <p>No saved reviews match this filter.</p>
                ) : null}
              </section>
            ) : null}
            {!draftOpen && view?.history?.total === 0 ? (
              <EmptyState
                title="No council reviews yet"
                hint="Prepare an original and inspect exactly what will be reviewed."
              >
                <Button variant="primary" onClick={() => setDraftOpen(true)}>
                  New review
                </Button>
              </EmptyState>
            ) : null}
            {!draftOpen && view?.history?.total ? (
              <Button variant="primary" onClick={() => setDraftOpen(true)}>
                New review
              </Button>
            ) : null}
            {draftOpen ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  prepare();
                }}
              >
                <Field label="Source type" id="council-source-type">
                  <Select
                    id="council-source-type"
                    value={draft.sourceType}
                    onChange={(event) => {
                      const sourceType = parseSourceType(
                        event.currentTarget.value,
                      );
                      if (sourceType) update({ sourceType });
                    }}
                  >
                    <option value="bead">Beads issue</option>
                    <option value="pr">GitHub pull request</option>
                    <option value="plan">Local Markdown plan</option>
                    <option value="file">Local research or text file</option>
                    <option value="text">Paste text</option>
                  </Select>
                </Field>
                <Field
                  label={
                    draft.sourceType === "text"
                      ? "Document or question"
                      : draft.sourceType === "pr"
                        ? "Pull request number or URL"
                        : draft.sourceType === "bead"
                          ? "Beads issue ID"
                          : "Workspace-relative file"
                  }
                  id="council-source"
                >
                  {draft.sourceType === "text" ? (
                    <Textarea
                      id="council-source"
                      rows={9}
                      value={draft.source}
                      onInput={(event) =>
                        update({ source: event.currentTarget.value })
                      }
                      placeholder="Paste the document or question to review…"
                    />
                  ) : (
                    <Input
                      id="council-source"
                      value={draft.source}
                      onInput={(event) =>
                        update({ source: event.currentTarget.value })
                      }
                    />
                  )}
                </Field>
                {draftCacheError && <p role="alert">{draftCacheError}</p>}
                {sourceError ? <p role="alert">{sourceError}</p> : null}
                <Field label="Council profile" id="council-profile">
                  <Select
                    id="council-profile"
                    value={profile?.path ?? ""}
                    onChange={(event) =>
                      update({ profileChoice: event.currentTarget.value })
                    }
                    disabled={!view?.profiles.length}
                  >
                    {view?.profiles.map((choice) => (
                      <option key={choice.path} value={choice.path}>
                        {projectCouncilShownLabel(choice.title)} ·{" "}
                        {choice.depth}
                      </option>
                    ))}
                  </Select>
                </Field>
                {profile ? (
                  <section aria-label="Selected profile">
                    <h3>
                      {projectCouncilShownLabel(profile.title)} ·{" "}
                      {profile.depth} · estimated ceiling $
                      {profile.maxEstimatedUsd.toFixed(2)}
                    </h3>
                    <ul>
                      {[...profile.seats, profile.chair].map((seat) => (
                        <li key={seat.id}>
                          {projectCouncilShownLabel(seat.role)} —{" "}
                          {projectCouncilShownLabel(seat.provider)} /{" "}
                          {projectCouncilShownLabel(seat.model)}
                          {seat.openRouter?.only?.length
                            ? ` · routed to ${seat.openRouter.only.map(projectCouncilShownLabel).join(", ")}`
                            : ""}
                        </li>
                      ))}
                    </ul>
                    <ul>
                      {selectedReady.map((item) => (
                        <li key={item.provider}>
                          {projectCouncilShownLabel(item.provider)}:{" "}
                          {item.configured
                            ? "configured"
                            : `not configured${item.missing.length ? `; missing ${item.missing.map(projectCouncilShownLabel).join(", ")}` : ""}`}
                        </li>
                      ))}
                    </ul>
                    {selectedReady.some((item) => item.routing?.length) ? (
                      <details>
                        <summary>Gateway routing policy</summary>
                        {selectedReady.flatMap((item) =>
                          (item.routing ?? []).map((route) => (
                            <p key={`${item.provider}:${route.seatId}`}>
                              {projectCouncilShownLabel(route.seatId)}:{" "}
                              {route.only
                                ?.map(projectCouncilShownLabel)
                                .join(", ") ?? "any eligible endpoint"}{" "}
                              · fallback{" "}
                              {route.allow_fallbacks ? "enabled" : "disabled"} ·
                              data collection {route.data_collection} ·
                              zero-retention filter {route.zdr ? "on" : "off"}.
                            </p>
                          )),
                        )}
                      </details>
                    ) : null}
                    {!ready ? (
                      <p role="alert">
                        This profile is not configured for a review in this
                        Hearth.
                      </p>
                    ) : null}
                  </section>
                ) : null}
                <Field label="Maximum estimated cost (USD)" id="council-budget">
                  <input
                    id="council-budget"
                    class="af-input"
                    type="number"
                    min="0"
                    max="1000000"
                    step="0.01"
                    value={draft.maxUsd}
                    onInput={(event) =>
                      update({ maxUsd: event.currentTarget.value })
                    }
                  />
                </Field>
                <Field label="Maximum prepared bytes" id="council-max-bytes">
                  <input
                    id="council-max-bytes"
                    class="af-input"
                    type="number"
                    min="1"
                    max="1048576"
                    step="1"
                    value={draft.maxBytes}
                    onInput={(event) =>
                      update({ maxBytes: event.currentTarget.value })
                    }
                  />
                </Field>
                {amountError ? <p role="alert">{amountError}</p> : null}
                <label>
                  <input
                    type="checkbox"
                    checked={draft.redactSecrets}
                    onChange={(event) =>
                      update({ redactSecrets: event.currentTarget.checked })
                    }
                  />{" "}
                  Redact detected secrets; otherwise source preparation rejects
                  them
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.deepDiscussion}
                    onChange={(event) =>
                      update({ deepDiscussion: event.currentTarget.checked })
                    }
                  />{" "}
                  Allow deep discussion when supported by this profile
                </label>
                <p class="af-muted">
                  Preparing stores a private original for review. It does not
                  start a Council run or contact a model provider.
                </p>
                <Button
                  variant="primary"
                  onClick={prepare}
                  disabled={!canPrepare}
                >
                  {view?.phase === "preparing"
                    ? "Preparing original…"
                    : "Prepare original for review"}
                </Button>
                {!writesAllowed || archived || !workspace ? (
                  <p role="status">
                    A writable, served project workspace is required to prepare
                    a new original.
                  </p>
                ) : null}
              </form>
            ) : null}
          </>
        )
      ) : null}
    </section>
  );
}
