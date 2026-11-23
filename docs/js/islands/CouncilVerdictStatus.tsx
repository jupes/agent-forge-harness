import { parseBeadsIssueId } from "../../../scripts/run-correlation";
import type { EventsPage, LedgerPayloads } from "../../../types/hearth";
import { useOperatorRead } from "../use-stream";

export type CouncilVerdictJob = {
  runId: string;
  status: "running" | "cancelling" | "completed" | "failed" | "cancelled";
  startedAt: string;
  run?:
    | {
        status: "running" | "cancelling" | "completed" | "failed" | "cancelled";
        context: { source: { kind: string; locator: string } };
      }
    | undefined;
};

const KINDS = ["council.verdict.comment"] as const;
type Status = LedgerPayloads["council.verdict.comment"]["status"];
const MESSAGES: Record<Status, string> = {
  posted: "Verdict comment posted to the bead.",
  refused:
    "Verdict comment was not posted: the write was refused. Check this bead’s comments.",
  unknown:
    "Verdict comment status not known. Check this bead’s comments before trying again.",
};

/** Only the source actually reviewed names the bead, never the editable draft. */
export function verdictBead(job: CouncilVerdictJob): string | null {
  const source = job.run?.context?.source;
  return job.status === "completed" &&
    job.run?.status === "completed" &&
    source?.kind === "bead"
    ? parseBeadsIssueId(source.locator) === source.locator
      ? source.locator
      : null
    : null;
}

/** A missing or truncated page is no evidence that a comment was refused. */
export function verdictStatus(
  job: CouncilVerdictJob,
  page: EventsPage | null,
): Status {
  const bead = verdictBead(job);
  const start = Date.parse(job.startedAt);
  if (
    !bead ||
    !Number.isFinite(start) ||
    !Array.isArray(page?.events) ||
    page.more
  )
    return "unknown";
  const found = new Set<Status>();
  for (const event of page.events) {
    if (
      event?.kind !== "council.verdict.comment" ||
      event.beadId !== bead ||
      event.payload?.councilRunId !== job.runId ||
      !Number.isFinite(Date.parse(event.ts)) ||
      Date.parse(event.ts) < start
    )
      continue;
    const status = event.payload.status;
    if (status === "posted" || status === "refused" || status === "unknown")
      found.add(status);
  }
  return found.size === 1 ? [...found][0]! : "unknown";
}

export function CouncilVerdictStatus({
  job,
  bead,
}: {
  job: CouncilVerdictJob;
  bead: string;
}) {
  // This child is keyed by the job: an old read cannot flash the previous run's outcome.
  // No after cursor: /events returns the newest tail. An omitted match stays unknown.
  const path = `/events?${new URLSearchParams({ bead, beadExact: "1", kind: KINDS[0], since: job.startedAt, limit: "1000" })}`;
  const state = useOperatorRead<EventsPage>(path, KINDS);
  const status = verdictStatus(job, state.error ? null : state.data);
  return (
    <p
      className={`notice${status === "posted" ? "" : " warning"}`}
      data-testid="council-verdict-status"
      aria-live="polite"
    >
      {MESSAGES[status]}
    </p>
  );
}
