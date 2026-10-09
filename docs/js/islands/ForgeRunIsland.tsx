import type { JSX } from "preact";
import { useState } from "preact/hooks";
import {
  boardRows,
  type ForgeRunSnapshot,
  type ForgeRunView,
  type GateRun,
  type GateScope,
  type RunBoardRow,
  type RunHealth,
} from "../../../scripts/dashboard/forge-run-model";
import type { BeadsPayload } from "../../../types/beads";
import { Button } from "../ds/Button";
import { Card } from "../ds/Card";
import { EmptyState } from "../ds/EmptyState";
import { Field, Select, Textarea } from "../ds/Field";
import { Icon, type IconName } from "../ds/Icon";
import { ProgressBar } from "../ds/ProgressBar";
import { Tag } from "../ds/Tag";
import {
  type Checkpoint,
  type CheckpointSummary,
  checkpointsForEpic,
} from "../forge-checkpoints";
import { statusLabel, statusTone } from "../issue-presentation";
import { useDevApi } from "../use-dev-api";

const REVIEW_URL = "/__agent-forge/dev-api/forge-run/review";

const PHASE_LABEL: Record<string, string> = {
  research: "Research",
  plan: "Plan",
  implement: "Implement",
  ship: "Ship",
};

const PHASE_ICON: Record<string, IconName> = {
  research: "magnifying-glass",
  plan: "list-bullets",
  implement: "code",
  ship: "git-pull-request",
};

const PHASE_BLURB: Record<string, string> = {
  research: "Explore real code, then resolve what the code cannot answer.",
  plan: "TDD- and Beads-shaped, with demo checkpoints.",
  implement: "Red-green-refactor, pausing at each demo checkpoint.",
  ship: "Summary, walkthrough, quality gates, then the PR.",
};

const CHECKPOINT_ICON: Record<string, IconName> = {
  closed: "check-circle-fill",
  in_progress: "circle-half",
  blocked: "warning-circle",
  open: "circle",
};

export interface ForgeRunIslandProps {
  /** The Beads snapshot; checkpoints come from it, like every other view. */
  payload: BeadsPayload | null;
}

const HEALTH_LABEL: Record<RunHealth, string> = {
  shipped: "Shipped",
  attention: "Needs attention",
  running: "In flight",
};

const HEALTH_ICON: Record<RunHealth, IconName> = {
  shipped: "check-circle-fill",
  attention: "warning-circle",
  running: "circle-half",
};

/** Short local time, with the full timestamp on hover. */
function shortTime(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/** One run on the board: identity, phase progress, and how it is doing. */
function RunBoardEntry({
  row,
  current,
  onSelect,
}: {
  row: RunBoardRow;
  current: boolean;
  onSelect: (slug: string) => void;
}): JSX.Element {
  const phaseSummary =
    row.status === "shipped"
      ? "Shipped"
      : (PHASE_LABEL[row.status] ?? row.status);

  return (
    <li>
      <button
        type="button"
        class={`af-run-row af-run-row-${row.health}${current ? " af-run-row-current" : ""}`}
        aria-current={current ? "true" : undefined}
        onClick={() => onSelect(row.slug)}
      >
        <span class="af-run-head">
          <Icon name={HEALTH_ICON[row.health]} size={14} />
          <span class="af-run-slug">{row.slug}</span>
          <Tag tone={row.mode === "auto" ? "accent" : "muted"}>{row.mode}</Tag>
          <span class="af-sr-only">{HEALTH_LABEL[row.health]}</span>
        </span>

        {/* Decorative: the same progress is spelled out in the meta row. */}
        <span class="af-run-strip" aria-hidden="true">
          {row.phases.map((phase) => (
            <span
              key={phase.id}
              class={`af-run-seg af-run-seg-${phase.state}${
                phase.artifactMissing ? " af-run-seg-missing" : ""
              }`}
              title={`${PHASE_LABEL[phase.id]} — ${phase.state}${
                phase.artifactMissing ? " (artifact missing)" : ""
              }`}
            />
          ))}
        </span>

        <span class="af-run-meta">
          <span class="af-run-phase">
            {phaseSummary} · {row.completedCount}/{row.totalPhases}
          </span>
          {row.gatePassed === null ? null : (
            <Tag tone={row.gatePassed ? "neutral" : "outline"}>
              gate {row.gatePassed ? "passed" : "failed"}
            </Tag>
          )}
          {row.reviewRounds > 0 ? (
            <Tag tone={row.latestVerdict === "PASS" ? "neutral" : "outline"}>
              {row.reviewRounds} review{row.reviewRounds === 1 ? "" : "s"}
              {row.latestVerdict ? ` · ${row.latestVerdict}` : ""}
            </Tag>
          ) : null}
          <span class="af-muted" title={row.updatedAt ?? undefined}>
            {shortTime(row.updatedAt)}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * Every run at once.
 *
 * Runs are concurrent, and the question a reader arrives with is "which of
 * these needs me?" — so the board leads with all of them and their phase
 * progress, and the detailed panel below follows whichever one is selected.
 * With a single run the board would just repeat that panel, so it is skipped.
 */
function RunsBoard({
  runs,
  selected,
  onSelect,
}: {
  runs: ForgeRunView[];
  selected: string;
  onSelect: (slug: string) => void;
}): JSX.Element | null {
  if (runs.length < 2) return null;
  const rows = boardRows(runs);
  const live = rows.filter((row) => row.health !== "shipped").length;

  return (
    <Card
      kicker="concurrent runs"
      title={`${rows.length} runs · ${live} in flight`}
      headingLevel={2}
    >
      <ul class="af-run-board">
        {rows.map((row) => (
          <RunBoardEntry
            key={row.slug}
            row={row}
            current={row.slug === selected}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </Card>
  );
}

/**
 * The Forge pipeline runs in flight.
 *
 * Phases and the quality-gate run come from this machine's harness state
 * through the dev-only API; checkpoints come from the Beads snapshot; a review
 * of an in-progress checkpoint is recorded as a `review:` comment in Beads.
 *
 * Runs are concurrent, so the snapshot carries all of them and this view shows
 * one at a time — the newest still in flight, until you pick another.
 */
export function ForgeRunIsland({ payload }: ForgeRunIslandProps): JSX.Element {
  const { data, error, loading } = useDevApi<ForgeRunSnapshot>("/forge-run");
  const [picked, setPicked] = useState<string | null>(null);

  if (loading) return <EmptyState title="Reading forge state…" live />;

  if (error) {
    return (
      <EmptyState
        title="Forge run needs the local dashboard"
        hint={
          <>
            This view reads <code>.tmp/work/forge-runs/</code> and the
            quality-gate log from the machine running the harness. Start{" "}
            <code>bun run dashboard</code> at the harness root and open this
            page on its local address.
          </>
        }
      />
    );
  }

  if (!data) return <EmptyState title="No forge state available" />;

  const run =
    data.runs.find((candidate) => candidate.slug === picked) ??
    data.runs.find((candidate) => candidate.slug === data.selected) ??
    null;

  if (run === null) {
    return (
      <>
        <EmptyState
          title="No forge run in flight"
          hint={
            <>
              Start one with <code>/forgemaster &lt;feature&gt;</code> or{" "}
              <code>/forgemaster-auto &lt;feature&gt;</code>. Runs are
              concurrent — several can be in flight at once.
            </>
          }
        />
        <GateCard
          gate={data.gate}
          scope={{ checkout: data.checkout, slug: null }}
        />
      </>
    );
  }

  return (
    <>
      <RunsBoard runs={data.runs} selected={run.slug} onSelect={setPicked} />

      <Card
        kicker={run.complete ? "shipped run" : `active run · ${run.mode}`}
        title={run.slug}
        headingLevel={2}
        actions={run.epic ? <Tag tone="accent">{run.epic}</Tag> : undefined}
      >
        {run.feature ? <p class="af-prose">{run.feature}</p> : null}
        {run.updatedAt ? (
          <p class="af-muted">
            State last written {new Date(run.updatedAt).toLocaleString()}
          </p>
        ) : null}
      </Card>

      <div class="af-phase-list">
        {run.phases.map((phase) => (
          <div key={phase.id} class={`af-phase af-phase-${phase.state}`}>
            <span class="af-phase-node" aria-hidden="true">
              <Icon name={PHASE_ICON[phase.id] ?? "circle"} size={14} />
            </span>
            <div class="af-phase-body">
              <div class="af-phase-head">
                <h3 class="af-phase-title">{PHASE_LABEL[phase.id]}</h3>
                <Tag
                  tone={
                    phase.state === "complete"
                      ? "neutral"
                      : phase.state === "active"
                        ? "accent"
                        : "muted"
                  }
                >
                  {phase.state}
                </Tag>
                {phase.artifactMissing ? (
                  <Tag tone="outline">
                    <Icon name="warning-circle" size={12} />
                    artifact missing
                  </Tag>
                ) : null}
              </div>
              <p class="af-muted">{PHASE_BLURB[phase.id]}</p>
              {phase.artifact ? (
                <p class="af-phase-artifact">
                  <code>{phase.artifact}</code>
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <CheckpointsCard payload={payload} epicId={run.epic} />
      <GateCard gate={run.gate} scope={run.gateScope} />
      {data.unattributedGate ? (
        <GateCard
          gate={data.unattributedGate}
          scope={{ checkout: data.checkout, slug: null }}
          unattributed
        />
      ) : null}
    </>
  );
}

function CheckpointsCard({
  payload,
  epicId,
}: {
  payload: BeadsPayload | null;
  epicId: string | null;
}): JSX.Element {
  if (!epicId) {
    return (
      <Card title="Checkpoints" headingLevel={2}>
        <p class="af-muted">
          This run has no epic recorded, so there are no Beads checkpoints to
          follow.
        </p>
      </Card>
    );
  }

  if (!payload) {
    return (
      <Card title="Checkpoints" headingLevel={2} kicker={epicId}>
        <EmptyState
          title="Load the Beads snapshot to see checkpoints"
          hint={
            <>
              Use Refresh snapshot, or run <code>bun run build-pages</code>.
            </>
          }
        />
      </Card>
    );
  }

  const summary = checkpointsForEpic(payload, epicId);

  if (summary.state === "empty") {
    return (
      <Card title="Checkpoints" headingLevel={2} kicker={epicId}>
        <p class="af-muted">
          No checkpoint tasks under {epicId} in the loaded snapshot.
        </p>
      </Card>
    );
  }

  const reviewable = summary.checkpoints.filter((checkpoint) =>
    summary.inProgressIds.includes(checkpoint.id),
  );
  const current = summary.inProgressIds[0] ?? null;
  const next = summary.state === "ready" ? summary.nextReadyId : null;

  return (
    <Card title="Checkpoints" headingLevel={2} kicker={epicId}>
      <ProgressBar
        value={summary.done}
        max={summary.total}
        label={`${summary.done} of ${summary.total} checkpoints complete`}
      />
      <p class="af-checkpoint-progress">
        {summary.done} of {summary.total} complete
      </p>

      <ol class="af-checkpoints">
        {summary.checkpoints.map((checkpoint) => {
          const isNext = checkpoint.id === next;
          const classes = [
            "af-checkpoint",
            checkpoint.status === "in_progress" ? "is-active" : "",
            isNext ? "is-next" : "",
          ];
          return (
            <li
              key={checkpoint.id}
              class={classes.filter(Boolean).join(" ")}
              aria-current={checkpoint.id === current ? "step" : undefined}
            >
              <Icon
                name={CHECKPOINT_ICON[checkpoint.status] ?? "circle"}
                size={14}
                label={statusLabel(checkpoint.status)}
              />
              <div class="af-checkpoint-body">
                <p class="af-checkpoint-title">{checkpoint.title}</p>
                <p class="af-checkpoint-meta">
                  <code>{checkpoint.id}</code>
                  {checkpoint.groupTitle ? ` · ${checkpoint.groupTitle}` : ""}
                  {checkpoint.blockedBy.length > 0 ? (
                    <span class="af-checkpoint-waiting">
                      {" "}
                      · waiting on {checkpoint.blockedBy.join(", ")}
                    </span>
                  ) : null}
                </p>
              </div>
              <span class="af-checkpoint-tags">
                {isNext ? <Tag tone="accent">next</Tag> : null}
                <Tag tone={statusTone(checkpoint.status)}>
                  {statusLabel(checkpoint.status)}
                </Tag>
              </span>
            </li>
          );
        })}
      </ol>

      {summary.state === "in-progress" ? (
        <ReviewActions
          key={summary.inProgressIds.join(" ")}
          checkpoints={reviewable}
        />
      ) : (
        <RunStateNote summary={summary} />
      )}
    </Card>
  );
}

/** What a run with nothing to review is waiting for — never a false "done". */
function RunStateNote({
  summary,
}: {
  summary: CheckpointSummary;
}): JSX.Element {
  if (summary.state === "complete") {
    return (
      <p class="af-checkpoint-state" data-state="complete">
        All {summary.total} checkpoints are closed.
      </p>
    );
  }

  if (summary.state === "ready" && summary.nextReadyId) {
    return (
      <p class="af-checkpoint-state" data-state="ready">
        Nothing is in progress. Next up is <code>{summary.nextReadyId}</code> —
        claim it with <code>bd update {summary.nextReadyId} --claim</code>.
        Reviews open once a checkpoint is in progress.
      </p>
    );
  }

  const remaining = summary.total - summary.done;
  const markedBlocked = summary.checkpoints
    .filter((checkpoint) => checkpoint.status === "blocked")
    .map((checkpoint) => checkpoint.id);
  return (
    <p class="af-checkpoint-state is-waiting" data-state="waiting">
      {remaining} of {summary.total} checkpoints remain, but none is in progress
      or ready to start.
      {summary.waitingOn.length > 0 ? (
        <>
          {" "}
          Waiting on <code>{summary.waitingOn.join(", ")}</code>.
        </>
      ) : null}
      {markedBlocked.length > 0 ? (
        <>
          {" "}
          Marked blocked in Beads: <code>{markedBlocked.join(", ")}</code>.
        </>
      ) : null}
      {summary.waitingOn.length === 0 && markedBlocked.length === 0
        ? " Their blocking dependencies form a cycle."
        : null}
    </p>
  );
}

function ReviewActions({
  checkpoints,
}: {
  checkpoints: Checkpoint[];
}): JSX.Element | null {
  const [selectedId, setSelectedId] = useState(checkpoints[0]?.id ?? "");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null,
  );

  const selected =
    checkpoints.find((checkpoint) => checkpoint.id === selectedId) ??
    checkpoints[0];
  if (!selected) return null;
  const target: Checkpoint = selected;

  async function record(decision: "approve" | "request-changes") {
    setPending(decision);
    setResult(null);
    try {
      const response = await fetch(REVIEW_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issueId: target.id, decision, note }),
      });
      const envelope = (await response.json()) as {
        ok: boolean;
        error: string | null;
      };
      if (!response.ok || !envelope.ok) {
        throw new Error(envelope.error ?? `HTTP ${response.status}`);
      }
      setResult({
        ok: true,
        message: `Recorded a review: comment on ${target.id}. Refresh the snapshot to see it in the issue's history.`,
      });
      setNote("");
    } catch (cause) {
      setResult({
        ok: false,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      setPending(null);
    }
  }

  return (
    <section class="af-review" aria-labelledby="forge-review-heading">
      <h3 id="forge-review-heading" class="af-review-heading">
        {checkpoints.length === 1 ? (
          <>
            Review checkpoint <code>{target.id}</code>
          </>
        ) : (
          "Review an in-progress checkpoint"
        )}
      </h3>
      <p class="af-muted af-prose">
        Adds a <code>review:</code> comment in Beads. Only a checkpoint that is
        in progress can be reviewed, and a request for changes must say what to
        change.
      </p>
      {checkpoints.length > 1 ? (
        <Field label="Checkpoint" id="forge-review-checkpoint">
          <Select
            id="forge-review-checkpoint"
            value={target.id}
            disabled={pending !== null}
            onChange={(event) => {
              setSelectedId(event.currentTarget.value);
              setResult(null);
            }}
          >
            {checkpoints.map((checkpoint) => (
              <option key={checkpoint.id} value={checkpoint.id}>
                {checkpoint.id} — {checkpoint.title}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label="Note" id="forge-review-note">
        <Textarea
          id="forge-review-note"
          value={note}
          rows={3}
          placeholder="What you checked, or what needs to change"
          onInput={(event) => setNote(event.currentTarget.value)}
          disabled={pending !== null}
        />
      </Field>
      <div class="af-button-row">
        <Button
          variant="primary"
          icon="check-circle-fill"
          disabled={pending !== null}
          onClick={() => void record("approve")}
        >
          {pending === "approve" ? "Recording…" : "Approve checkpoint"}
        </Button>
        <Button
          disabled={pending !== null || !note.trim()}
          onClick={() => void record("request-changes")}
        >
          {pending === "request-changes" ? "Recording…" : "Request changes"}
        </Button>
      </div>
      {result ? (
        <p
          role="status"
          class={`af-review-result${result.ok ? "" : " is-error"}`}
        >
          {result.message}
        </p>
      ) : null}
    </section>
  );
}

/** How a gate run that is not correlated to the run on show came to be here. */
function GateLinkNote({ gate }: { gate: GateRun }): JSX.Element | null {
  if (gate.link === "unlinked") {
    return (
      <p class="af-muted af-gate-link">
        Not correlated to a Beads issue or a forge run
        {gate.unlinkedReason ? `: ${gate.unlinkedReason}` : ""}. It counts
        toward no run.
      </p>
    );
  }
  if (gate.link === "legacy") {
    return (
      <p class="af-muted af-gate-link">
        Logged before gate runs carried a run correlation
        {gate.taskId ? (
          <>
            ; its task field read <code>{gate.taskId}</code>
          </>
        ) : null}
        . It does not count toward the run's health.
      </p>
    );
  }
  return null;
}

/**
 * One gate run. `unattributed` is the card for a gate run of this checkout
 * that no forge run's card shows: one that was given no run correlation, or
 * one correlated to a run that has no state here.
 */
function GateCard({
  gate,
  scope,
  unattributed = false,
}: {
  gate: GateRun | null;
  scope: GateScope;
  unattributed?: boolean;
}): JSX.Element {
  const scopeText = unattributed ? (
    <>
      this checkout (<code>{scope.checkout}</code>) that belongs to none of its
      forge runs
    </>
  ) : (
    <>
      this checkout (<code>{scope.checkout}</code>)
      {scope.slug ? (
        <>
          {" "}
          and forge run <code>{scope.slug}</code>
        </>
      ) : (
        " with no forge run in flight"
      )}
    </>
  );
  const title = unattributed ? "Unattributed gate run" : "Quality gate";

  if (!gate) {
    return (
      <Card title={title} headingLevel={2}>
        <EmptyState
          title="No quality-gate run recorded for this checkout"
          hint={
            <>
              The TaskCompleted and TeammateIdle hooks log every run to one log
              shared by all checkouts, recording where each ran. This panel
              shows the newest run from {scopeText}. Runs from other worktrees
              or forge runs, runs that were given no run correlation, and
              entries logged before runs recorded that, are not shown.
            </>
          }
        />
      </Card>
    );
  }

  return (
    <Card
      title={title}
      headingLevel={2}
      kicker={gate.event || "latest run"}
      actions={
        <>
          {gate.link === "linked" ? null : <Tag tone="muted">{gate.link}</Tag>}
          <Tag tone={gate.passed ? "neutral" : "outline"}>
            {gate.passed ? "passed" : "failed"}
          </Tag>
        </>
      }
    >
      <p class="af-muted af-gate-scope">
        Newest run from {scopeText}
        {gate.timestamp
          ? `, at ${new Date(gate.timestamp).toLocaleString()}`
          : ""}
        {gate.branch ? (
          <>
            {" "}
            on <code>{gate.branch}</code>
          </>
        ) : null}
        {gate.link === "linked" && gate.beadsIssueId ? (
          <>
            {" "}
            for bead <code>{gate.beadsIssueId}</code>
            {unattributed && gate.executionRunId ? (
              <>
                , correlated to run <code>{gate.executionRunId}</code>, which
                has no state in this checkout
              </>
            ) : null}
          </>
        ) : null}
        .
      </p>
      <GateLinkNote gate={gate} />
      <ul class="af-gate-grid">
        {gate.checks.map((check) => {
          const state = check.skipped
            ? "skipped"
            : check.passed
              ? "passed"
              : "failed";
          return (
            <li key={check.name} class={`af-gate-check is-${state}`}>
              <p class="af-gate-name">
                <Icon
                  name={
                    state === "passed"
                      ? "check-circle-fill"
                      : state === "failed"
                        ? "warning-circle"
                        : "circle"
                  }
                  size={14}
                  label={state}
                />
                {check.name}
              </p>
              {check.detail ? (
                <p class="af-gate-detail">{check.detail}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
