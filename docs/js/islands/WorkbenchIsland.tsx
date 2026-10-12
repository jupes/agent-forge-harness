import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { Eligibility } from "../../../scripts/scheduler/eligibility";
import type { OperatorMove } from "../../../scripts/scheduler/queue-table";
import type {
  LedgerEventKind,
  QueueEntry,
  SmithsView,
} from "../../../types/hearth";
import { Button } from "../ds/Button";
import { EmptyState } from "../ds/EmptyState";
import { Field, Select } from "../ds/Field";
import { Tag } from "../ds/Tag";
import { operatorPost } from "../operator";
import { useOperatorRead } from "../use-stream";
import {
  type MoveOutcome,
  moveOutcome,
  type WorkbenchCard,
  type WorkbenchColumn,
  workbenchColumns,
} from "../workbench-model";

/** What makes the Workbench read the queue and eligibility again. */
const WORKBENCH_KINDS: readonly LedgerEventKind[] = [
  "bead.transitioned",
  "operator.action",
  "reservation.acquired",
  "reservation.released",
];
/** The smiths are read once. */
const NO_KINDS: readonly LedgerEventKind[] = [];

const MOVE_LABEL: Record<OperatorMove, string> = {
  approve: "Approve",
  queue: "Queue",
  pause: "Pause",
  resume: "Resume",
  reassign: "Reassign",
};
export interface WorkbenchViewProps {
  columns: WorkbenchColumn[];
  /** Enabled smiths, by name. */
  smiths: string[];
  /** The move in flight for a bead, if any. */
  pending: Record<string, OperatorMove>;
  outcomes: Record<string, MoveOutcome>;
  /** Stale reservations (their bead is closed or gone), to mention once. */
  staleCount: number;
  /** Reads that failed, in the hearth's words: what the board cannot show. */
  notices: string[];
  onMove(id: string, move: OperatorMove, smith?: string): void;
}

/** The queue as columns: the pure view, testable as a function. */
export function WorkbenchView(props: WorkbenchViewProps): JSX.Element {
  return (
    <>
      {props.notices.map((notice) => (
        <p class="af-notice" role="status" key={notice}>
          {notice}
        </p>
      ))}
      {props.staleCount > 0 ? (
        <p class="af-notice">
          {props.staleCount} reservation
          {props.staleCount === 1 ? " is" : "s are"} held for beads that are
          closed or gone; they are ignored. Free them with{" "}
          <code>bun run forge:reservations release</code>.
        </p>
      ) : null}
      <div class="af-workbench" role="list" aria-label="Queue states">
        {props.columns.map((column) => (
          <section
            class="af-workbench-column"
            role="listitem"
            aria-label={column.label}
            data-column={column.state}
            key={column.state}
          >
            <h2 class="af-workbench-heading">
              {column.label}{" "}
              <span class="af-muted">
                {column.cards.length + column.hidden}
              </span>
            </h2>
            {column.cards.map((card) => (
              <CardView
                key={`${card.state}:${card.id}`}
                card={card}
                {...props}
              />
            ))}
            {column.hidden > 0 ? (
              <p class="af-muted">and {column.hidden} more</p>
            ) : null}
          </section>
        ))}
      </div>
    </>
  );
}

function CardView({
  card,
  smiths,
  pending,
  outcomes,
  onMove,
}: { card: WorkbenchCard } & WorkbenchViewProps): JSX.Element {
  const choices = smiths.filter((name) => name !== card.smith);
  const [smith, setSmith] = useState<string>(choices[0] ?? "");
  const busy = pending[card.id] !== undefined;
  const outcome = outcomes[card.id];
  const selectId = `wb-smith-${card.state}-${card.id}`;
  const chosen = choices.includes(smith) ? smith : (choices[0] ?? "");
  return (
    <article
      class="af-workbench-card"
      data-bead={card.id}
      aria-label={`${card.title} (${card.id})`}
    >
      <p class="af-workbench-title">{card.title || card.id}</p>
      <p class="af-muted af-workbench-id">
        <code>{card.id}</code>
      </p>
      <p class="af-workbench-smith" data-smith={card.smith ?? ""}>
        {card.smith === null
          ? "No smith"
          : card.smithIsDefault
            ? `default smith ${card.smith}`
            : `smith ${card.smith}`}
      </p>
      {card.start ? (
        card.start.may ? (
          <Tag tone="neutral">may start</Tag>
        ) : (
          <p class="af-workbench-wait" data-waits-on={card.start.waitsOn ?? ""}>
            <Tag tone="outline">waits</Tag> {card.start.why}
          </p>
        )
      ) : null}
      {card.note ? <p class="af-muted af-workbench-note">{card.note}</p> : null}
      {card.moves.length > 0 ? (
        <div class="af-button-row">
          {card.moves
            .filter((move) => move !== "reassign")
            .map((move) => (
              <Button
                key={move}
                variant={move === "approve" ? "primary" : "secondary"}
                disabled={busy}
                aria-label={`${MOVE_LABEL[move]} ${card.id}`}
                onClick={() => onMove(card.id, move)}
              >
                {pending[card.id] === move
                  ? `${MOVE_LABEL[move]}…`
                  : MOVE_LABEL[move]}
              </Button>
            ))}
        </div>
      ) : null}
      {card.moves.includes("reassign") && choices.length > 0 ? (
        <div class="af-workbench-reassign">
          <Field label={`Smith for ${card.id}`} id={selectId}>
            <Select
              id={selectId}
              value={chosen}
              disabled={busy}
              onChange={(event) => setSmith(event.currentTarget.value)}
            >
              {choices.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            disabled={busy || chosen === ""}
            aria-label={`Reassign ${card.id}`}
            onClick={() => onMove(card.id, "reassign", chosen)}
          >
            {pending[card.id] === "reassign" ? "Reassigning…" : "Reassign"}
          </Button>
        </div>
      ) : null}
      {outcome ? (
        <p
          role="status"
          class={`af-review-result af-bead-result${outcome.tone === "done" ? "" : " is-error"}`}
          data-outcome={outcome.tone}
        >
          {outcome.message}
        </p>
      ) : null}
    </article>
  );
}

/** What the board cannot show because a read failed, in the hearth's words. */
function readFailures(
  eligibility: { data: unknown; error: string | null },
  smiths: { data: unknown; error: string | null },
): string[] {
  const notices: string[] = [];
  if (eligibility.data === null && eligibility.error)
    notices.push(
      "Why a queued bead waits cannot be shown: the eligibility read failed (" +
        eligibility.error +
        ").",
    );
  if (smiths.data === null && smiths.error)
    notices.push(
      "Smiths cannot be shown or reassigned: the smiths read failed (" +
        smiths.error +
        ").",
    );
  return notices;
}

/**
 * The approval queue as a board: columns of queue states, a card per bead,
 * the operator's moves on each, a smith picker, and why a queued bead waits.
 * Reads the operator API, so it needs the local dashboard.
 */
export function WorkbenchIsland(): JSX.Element {
  const queue = useOperatorRead<QueueEntry[]>("/queue", WORKBENCH_KINDS);
  const eligibility = useOperatorRead<Eligibility>(
    "/eligibility",
    WORKBENCH_KINDS,
  );
  const smiths = useOperatorRead<SmithsView>("/smiths", NO_KINDS);
  const [pending, setPending] = useState<Record<string, OperatorMove>>({});
  const [outcomes, setOutcomes] = useState<Record<string, MoveOutcome>>({});

  if (queue.loading && queue.data === null)
    return <EmptyState title="Reading the queue…" live />;
  if (queue.data === null)
    return (
      <EmptyState
        title="The Workbench needs the local dashboard"
        hint={
          <>
            It reads and moves the approval queue through the control plane.
            Start <code>bun run dashboard</code> at the harness root and open
            this page on its local address.
            {queue.error ? ` (${queue.error})` : null}
          </>
        }
      />
    );

  const enabled = (smiths.data?.smiths ?? [])
    .filter((smith) => smith.enabled)
    .map((smith) => smith.name);
  const columns = workbenchColumns(
    queue.data,
    eligibility.data,
    smiths.data?.defaultSmith ?? null,
  );

  const onMove = (id: string, move: OperatorMove, smith?: string): void => {
    if (pending[id] !== undefined) return;
    setPending((all) => ({ ...all, [id]: move }));
    void moveOutcome(id, move, () =>
      operatorPost(
        `/__agent-forge/queue/${encodeURIComponent(id)}/${move}`,
        move === "reassign" ? { smith } : {},
      ),
    ).then((outcome) => {
      setOutcomes((all) => ({ ...all, [id]: outcome }));
      setPending(({ [id]: _done, ...rest }) => rest);
      // The ledger's events can arrive before the write lands: read again now.
      queue.reload();
      eligibility.reload();
    });
  };

  return (
    <WorkbenchView
      columns={columns}
      smiths={enabled}
      pending={pending}
      outcomes={outcomes}
      staleCount={eligibility.data?.stale.length ?? 0}
      notices={readFailures(eligibility, smiths)}
      onMove={onMove}
    />
  );
}
