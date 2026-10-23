import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Dialog } from "../../../docs/js/ds/Dialog";
import { keeperProposalDraftSchema } from "../../../scripts/keeper/proposal-protocol";
import type {
  KeeperProposalAction,
  KeeperProposalDraft,
  KeeperProposalView,
} from "../../../types/keeper-proposal";
import type { KeeperProposalsClient } from "./keeper-proposals-client";
import { desktopHref } from "./navigation";
import "./proposals.css";

const labels: Record<KeeperProposalAction["kind"], string> = {
  "approve-beads": "Approve beads",
  "start-session": "Start session",
  "start-shift": "Start shift",
  "send-to-council": "Send to council",
  "create-beads": "Create beads",
  "manage-bead": "Manage bead",
  "record-decision": "Record decision",
};
function Fields({
  draft,
  update,
  editable,
  original,
}: {
  draft: KeeperProposalDraft;
  update(value: KeeperProposalDraft): void;
  editable: boolean;
  original: KeeperProposalDraft;
}): JSX.Element {
  const action = draft.action;
  const change = (next: KeeperProposalAction) =>
    update({ ...draft, action: next });
  const field = (
    label: string,
    value: string | number,
    set: (value: string) => void,
    multiline = false,
  ) => (
    <label class="af-proposal-field">
      {label}
      {multiline ? (
        <textarea
          value={value}
          readOnly={!editable}
          rows={3}
          onInput={(event) => set(event.currentTarget.value)}
        />
      ) : (
        <input
          value={value}
          readOnly={!editable}
          onInput={(event) => set(event.currentTarget.value)}
        />
      )}
    </label>
  );
  switch (action.kind) {
    case "approve-beads": {
      const ids =
        original.action.kind === "approve-beads"
          ? original.action.beadIds
          : action.beadIds;
      return (
        <fieldset>
          <legend>Only checked beads will be approved</legend>
          {ids.map((id) => (
            <label class="af-proposal-check" key={id}>
              <input
                type="checkbox"
                checked={action.beadIds.includes(id)}
                disabled={!editable}
                onChange={(event) =>
                  change({
                    ...action,
                    beadIds: event.currentTarget.checked
                      ? [...action.beadIds, id]
                      : action.beadIds.filter((item) => item !== id),
                  })
                }
              />
              {id}
            </label>
          ))}
        </fieldset>
      );
    }
    case "record-decision":
      return (
        <>
          {field("Bead", action.beadId, (beadId) =>
            change({ ...action, beadId }),
          )}
          {field(
            "Decision",
            action.decision,
            (decision) => change({ ...action, decision }),
            true,
          )}
        </>
      );
    case "start-session":
      return (
        <>
          <label class="af-proposal-field">
            Provider
            <select
              disabled={!editable}
              value={action.provider}
              onChange={(event) => {
                const provider = event.currentTarget.value;
                if (
                  provider === "claude" ||
                  provider === "codex" ||
                  provider === "gemini" ||
                  provider === "grok"
                )
                  change({ ...action, provider });
              }}
            >
              {["claude", "codex", "gemini", "grok"].map((provider) => (
                <option key={provider}>{provider}</option>
              ))}
            </select>
          </label>
          {field("Smith", action.smith, (smith) =>
            change({ ...action, smith }),
          )}
          {field("Bead", action.beadId, (beadId) =>
            change({ ...action, beadId }),
          )}
          {field("Repository", action.repository, (repository) =>
            change({ ...action, repository }),
          )}
          <label class="af-proposal-field">
            Worktree
            <select
              disabled={!editable}
              value={action.worktree}
              onChange={(event) =>
                change({
                  ...action,
                  worktree:
                    event.currentTarget.value === "new" ? "new" : "current",
                })
              }
            >
              <option value="current">Current worktree</option>
              <option value="new">New worktree</option>
            </select>
          </label>
          {field(
            "Prompt",
            action.prompt,
            (prompt) => change({ ...action, prompt }),
            true,
          )}
        </>
      );
    case "start-shift":
      return (
        <>
          {field("Duration in minutes", action.durationMinutes, (value) =>
            change({ ...action, durationMinutes: Number(value) }),
          )}
          {field("Concurrency", action.concurrency, (value) =>
            change({ ...action, concurrency: Number(value) }),
          )}
          {field("Bead limit", action.beadLimit, (value) =>
            change({ ...action, beadLimit: Number(value) }),
          )}
          {field("Spend limit in USD", action.spendLimitUsd, (value) =>
            change({ ...action, spendLimitUsd: Number(value) }),
          )}
        </>
      );
    case "send-to-council":
      return (
        <>
          {field("Bead", action.beadId, (beadId) =>
            change({ ...action, beadId }),
          )}
          {field("Profile", action.profile, (profile) =>
            change({ ...action, profile }),
          )}
          {field(
            "Review question",
            action.question,
            (question) => change({ ...action, question }),
            true,
          )}
        </>
      );
    case "create-beads":
      return (
        <>
          {action.beads.map((bead, index) => {
            const edit = (next: typeof bead) =>
              change({
                ...action,
                beads: action.beads.map((item, at) =>
                  at === index ? next : item,
                ),
              });
            return (
              <fieldset key={index}>
                <legend>New bead {index + 1}</legend>
                {field("Title", bead.title, (title) =>
                  edit({ ...bead, title }),
                )}
                <label class="af-proposal-field">
                  Type
                  <select
                    disabled={!editable}
                    value={bead.type}
                    onChange={(event) => {
                      const type = event.currentTarget.value;
                      if (
                        type === "task" ||
                        type === "feature" ||
                        type === "bug" ||
                        type === "chore" ||
                        type === "epic"
                      )
                        edit({ ...bead, type });
                    }}
                  >
                    {["task", "feature", "bug", "chore", "epic"].map((type) => (
                      <option key={type}>{type}</option>
                    ))}
                  </select>
                </label>
                <label class="af-proposal-field">
                  Priority
                  <select
                    disabled={!editable}
                    value={bead.priority}
                    onChange={(event) => {
                      const value = Number(event.currentTarget.value);
                      if (
                        value === 0 ||
                        value === 1 ||
                        value === 2 ||
                        value === 3 ||
                        value === 4
                      )
                        edit({ ...bead, priority: value });
                    }}
                  >
                    {[0, 1, 2, 3, 4].map((priority) => (
                      <option key={priority} value={priority}>
                        P{priority}
                      </option>
                    ))}
                  </select>
                </label>
                {field("Parent bead", bead.parentId, (parentId) =>
                  edit({ ...bead, parentId }),
                )}
                {field(
                  "Description",
                  bead.description,
                  (description) => edit({ ...bead, description }),
                  true,
                )}
              </fieldset>
            );
          })}
        </>
      );
    case "manage-bead":
      return (
        <>
          {field("Bead", action.beadId, (beadId) =>
            change({ ...action, beadId }),
          )}
          <label class="af-proposal-field">
            Operation
            <select
              disabled={!editable}
              value={action.operation.kind}
              onChange={(event) => {
                const kind = event.currentTarget.value;
                if (kind === "pause" || kind === "resume")
                  change({ ...action, operation: { kind } });
                else if (kind === "reassign")
                  change({ ...action, operation: { kind, smith: "" } });
              }}
            >
              <option value="pause">Pause</option>
              <option value="resume">Resume</option>
              <option value="reassign">Reassign smith</option>
            </select>
          </label>
          {action.operation.kind === "reassign" &&
            field("Smith", action.operation.smith, (smith) =>
              change({ ...action, operation: { kind: "reassign", smith } }),
            )}
        </>
      );
  }
}

function ActionCard({
  projectId,
  card,
  client,
  writesAllowed,
  onNavigate,
}: {
  projectId: string;
  card: KeeperProposalView;
  client: KeeperProposalsClient;
  writesAllowed: boolean;
  onNavigate?: (() => void) | undefined;
}): JSX.Element {
  const state = client.get(projectId),
    record = client.record(projectId, card);
  const [editing, setEditing] = useState(false),
    [activityOpen, setActivityOpen] = useState(false);
  const activityOpener = useRef<HTMLElement>(null);
  const draft =
    record?.draft ?? state.drafts.get(card.proposal.id) ?? card.proposal.draft;
  const held = !!record || !!state.pending || state.posting;
  const blocked = held || !writesAllowed || state.loading || !!state.error;
  const valid = keeperProposalDraftSchema.safeParse(draft).success;
  const edited = JSON.stringify(draft) !== JSON.stringify(card.proposal.draft);
  const available =
    draft.action.kind !== "start-session" &&
    (card.available || (card.destinationAvailable && edited));
  const status = record
    ? {
        approved: "Approved · awaiting outcome",
        done: "Done",
        failed: "Failed",
        unknown: "Outcome unknown",
        dismissed: "Dismissed",
      }[record.phase]
    : state.pending?.body.id === card.proposal.id
      ? "Checking original review"
      : "Proposed";
  return (
    <article class="af-proposal-card" aria-label={card.proposal.draft.title}>
      <div class="af-proposal-heading">
        <span>{labels[draft.action.kind]}</span>
        <strong class="af-proposal-state">{status}</strong>
      </div>
      <h3>{draft.title}</h3>
      <p>{draft.detail}</p>
      <details open={editing}>
        <summary>Review proposed values</summary>
        <Fields
          draft={draft}
          original={card.proposal.draft}
          editable={editing && !held}
          update={(value) => client.draft(projectId, card.proposal.id, value)}
        />
      </details>
      {!valid && (
        <p role="alert">
          Enter valid values before approval. At least one bead must remain
          checked.
        </p>
      )}
      {!record && card.reason && (
        <p class="af-keeper-warning">
          {edited &&
          card.destinationAvailable &&
          draft.action.kind !== "start-session"
            ? "The edited values will be checked against current project scope and queue state before any change."
            : card.reason}
        </p>
      )}
      {record ? (
        <>
          <p role="status">{record.message}</p>
          <div class="af-keeper-object-links">
            {record.objects.map((object) => (
              <a
                key={`${object.kind}:${object.id}`}
                href={desktopHref({
                  projectId,
                  destination:
                    object.kind === "session"
                      ? "sessions"
                      : object.kind === "run"
                        ? "runs"
                        : object.kind === "event"
                          ? "activity"
                          : "beads",
                  selection: object,
                })}
                onClick={onNavigate}
              >
                {object.kind} {object.id}
              </a>
            ))}
          </div>
          {card.activity ? (
            <button
              type="button"
              onClick={(event) => {
                activityOpener.current = event.currentTarget;
                setActivityOpen(true);
              }}
            >
              View Activity · #{card.activity.id}
            </button>
          ) : (
            <p>Activity details are unavailable in this read.</p>
          )}
        </>
      ) : (
        <div class="af-proposal-actions">
          <Button
            variant="primary"
            disabled={blocked || !available || !valid}
            onClick={() => {
              setEditing(false);
              void client.review(projectId, card.proposal.id, "approve");
            }}
          >
            Approve
          </Button>
          <Button disabled={held} onClick={() => setEditing(!editing)}>
            {editing ? "Finish editing" : "Edit"}
          </Button>
          <Button
            disabled={blocked}
            onClick={() => {
              setEditing(false);
              void client.review(projectId, card.proposal.id, "dismiss");
            }}
          >
            Dismiss
          </Button>
        </div>
      )}
      <Dialog
        open={activityOpen}
        title="Approval Activity"
        titleId={`activity-${card.proposal.id}`}
        onClose={() => setActivityOpen(false)}
        returnFocusRef={activityOpener}
      >
        {card.activity && (
          <dl>
            <dt>Event</dt>
            <dd>#{card.activity.id}</dd>
            <dt>Action</dt>
            <dd>{card.activity.action}</dd>
            <dt>When</dt>
            <dd>
              <time dateTime={card.activity.at}>
                {new Date(card.activity.at).toLocaleString()}
              </time>
            </dd>
            <dt>Surface</dt>
            <dd>{card.activity.surface}</dd>
            <dt>Target</dt>
            <dd>{card.activity.target}</dd>
          </dl>
        )}
      </Dialog>
    </article>
  );
}

export function KeeperActionCards({
  projectId,
  client,
  writesAllowed,
  onNavigate,
}: {
  projectId: string;
  client: KeeperProposalsClient;
  writesAllowed: boolean;
  onNavigate?: (() => void) | undefined;
}): JSX.Element {
  const state = client.get(projectId);
  return (
    <section
      class="af-proposals"
      aria-label="Keeper action cards"
      aria-busy={state.loading}
    >
      <h2>Proposed actions</h2>
      <p>Review each card. Only Approve can carry out its reviewed change.</p>
      {state.loading && !state.page && (
        <p role="status">Loading action cards…</p>
      )}
      {state.error && <p role="alert">{state.error}</p>}
      <button
        type="button"
        class="af-btn af-btn-secondary af-proposals-refresh"
        aria-disabled={state.loading}
        onClick={() => {
          if (!state.loading) void client.refresh(projectId, true);
        }}
      >
        Refresh action cards
      </button>
      {state.notice && <p role="status">{state.notice}</p>}
      {state.pending && (
        <div class="af-keeper-warning">
          <p>
            Original review request: {state.pending.body.requestId}. Check its
            saved result; a retry uses this same request.
          </p>
          <Button
            disabled={state.posting || !writesAllowed || state.loading}
            onClick={() => {
              void client.retry(projectId);
            }}
          >
            Retry original review
          </Button>
        </div>
      )}
      {state.page?.problems.map((problem) => (
        <p key={problem}>{problem}</p>
      ))}
      {state.page && state.page.proposals.length === 0 && (
        <p>No verified action cards in the recent Keeper replies.</p>
      )}
      {state.page?.proposals.map((card) => (
        <ActionCard
          key={card.proposal.id}
          projectId={projectId}
          card={card}
          client={client}
          writesAllowed={writesAllowed}
          onNavigate={onNavigate}
        />
      ))}
      {[...state.receipts.values()]
        .filter(
          (record) =>
            !state.page?.proposals.some(
              (card) => card.proposal.id === record.id,
            ),
        )
        .map((record) => (
          <p key={record.id}>
            Earlier review · {record.draft.title} · {record.phase}:{" "}
            {record.message}
          </p>
        ))}
    </section>
  );
}
