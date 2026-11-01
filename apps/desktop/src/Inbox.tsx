import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { EmptyState } from "../../../docs/js/ds/EmptyState";
import {
  INBOX_SOURCE_KINDS,
  type InboxDispositionEntry,
} from "../../../types/inbox";
import type { ProjectsHome } from "../../../types/project-summary";
import type { InboxDispositionHistory } from "./inbox-dispositions-owner";
import type { InboxPermissionSnapshot } from "./inbox-model";
import type {
  InboxCard,
  InboxCoverage,
  InboxFilters,
  InboxSourceKind,
} from "./inbox-view";
import { bindInboxCardIdentity, projectInbox } from "./inbox-view";
import { desktopHref } from "./navigation";
import type { DesktopBeadWrites } from "./use-bead-writes";
import "./inbox.css";

function permissionCard(
  item: InboxPermissionSnapshot["items"][number],
  home: ProjectsHome | null,
  snapshot: InboxPermissionSnapshot,
): InboxCard {
  const project = home?.catalog.projects.find(
    (entry) => entry.id === item.projectId,
  );
  const current =
    item.state === "current" &&
    item.snapshotGeneration === snapshot.generation &&
    !snapshot.loading;
  const permission = item;
  const sourceIdentity = [
    item.provider,
    item.sessionId,
    item.acceptedTurnId,
    item.offerId,
  ];
  const label =
    item.state === "held"
      ? "Original permission decision held"
      : item.approval.provider === "codex"
        ? item.approval.value.kind === "command"
          ? "Command permission"
          : "File permission"
        : "Gemini permission";
  const detail =
    item.state === "held"
      ? "The original decision is held for receipt review. No replacement will be sent."
      : item.approval.provider === "codex"
        ? (item.approval.value.reason ?? "The source did not provide a reason.")
        : item.approval.value.detailsComplete
          ? "A verified Gemini approval is waiting."
          : "Approval details are incomplete. Open the session to review the source.";
  return {
    key: JSON.stringify([
      item.workspace,
      item.projectId,
      "permission",
      ...sourceIdentity,
    ]),
    projectId: item.projectId,
    workspace: item.workspace,
    projectName: project?.name ?? item.projectId,
    sourceKind: "permission",
    stableItemId: JSON.stringify(sourceIdentity),
    sourceRevision:
      item.state === "current"
        ? JSON.stringify(item.approval)
        : JSON.stringify(item.identity),
    title: label,
    detail,
    observedAt: item.observedAt,
    sourceState: current ? "current" : "unavailable",
    canSnooze: false,
    canCheck: false,
    permissionProvider: item.provider,
    ...(permission ? { permission } : {}),
    permissionKey: item.key,
    resolved: false,
    notice: false,
  };
}

function unboundInboxCard(card: InboxCard): InboxCard {
  return {
    ...card,
    key: card.permission?.key ?? card.unknownWriteKey ?? card.key,
    stableItemId: card.permission
      ? JSON.stringify([
          card.permission.provider,
          card.permission.sessionId,
          card.permission.acceptedTurnId,
          card.permission.offerId,
        ])
      : (card.unknownWriteKey ?? card.stableItemId),
    sourceState: "unavailable",
    canSnooze: false,
  };
}

export interface InboxProps {
  permission: InboxPermissionSnapshot;
  writeCards: readonly InboxCard[];
  writeCoverage: readonly InboxCoverage[];
  home: ProjectsHome | null;
  writes: DesktopBeadWrites;
  dispositions: readonly InboxDispositionEntry[];
  dispositionLoading: boolean;
  dispositionRefreshing: boolean;
  dispositionError: string;
  dispositionWritable: boolean;
  history: readonly InboxDispositionHistory[];
  holds: readonly InboxDispositionHistory["original"][];
  checkedOriginals: readonly string[];
  onAcknowledge(
    card: InboxCard,
    operation: "done" | "snooze-1h",
  ): Promise<void>;
  onCheckOriginal(requestId: string): Promise<boolean>;
  onDiscardOriginal(requestId: string): Promise<void>;
  onReviewOriginal(requestId: string): Promise<void>;
  onRetry(): void;
  loading: boolean;
  error: string;
}

export function Inbox(props: InboxProps) {
  const [filters, setFilters] = useState<InboxFilters>({
    projectId: "",
    sourceKind: "all",
    bucket: "needs-you",
  });
  const [, paint] = useState(0);
  const now = Date.now();
  const nextSnoozeExpiry = props.dispositions
    .map((entry) =>
      entry.operation === "snooze-1h" ? entry.snoozedUntil : undefined,
    )
    .filter((until): until is string => typeof until === "string")
    .map((until) => Date.parse(until))
    .filter((expiry) => Number.isFinite(expiry) && expiry > now)
    .sort((left, right) => left - right)[0];
  useEffect(() => {
    if (nextSnoozeExpiry === undefined) return;
    const timer = setTimeout(
      () => paint((value) => value + 1),
      Math.max(1, nextSnoozeExpiry - Date.now() + 1),
    );
    return () => clearTimeout(timer);
  }, [nextSnoozeExpiry]);

  const permissionCards = props.permission.items.map((item) =>
    permissionCard(item, props.home, props.permission),
  );
  const allCards = [...permissionCards, ...props.writeCards];
  const identitySignature = JSON.stringify(
    allCards.map((card) => [
      card.workspace,
      card.projectId,
      card.sourceKind,
      card.stableItemId,
      card.sourceRevision,
      card.observedAt,
      card.sourceState,
      card.detail,
      card.resolved,
      card.canSnooze,
      card.notice,
    ]),
  );
  const [boundCards, setBoundCards] = useState<{
    signature: string;
    cards: readonly InboxCard[];
  }>({ signature: "", cards: [] });
  const identityGeneration = useRef(0);
  useEffect(() => {
    const generation = ++identityGeneration.current;
    let current = true;
    void Promise.all(
      allCards.map(async (card) => {
        if (card.key.startsWith("sha256:")) return card;
        try {
          return await bindInboxCardIdentity(card);
        } catch {
          return unboundInboxCard(card);
        }
      }),
    ).then((cards) => {
      if (current && generation === identityGeneration.current)
        setBoundCards({ signature: identitySignature, cards });
    });
    return () => {
      current = false;
    };
  }, [identitySignature]);
  const projectedCards =
    boundCards.signature === identitySignature
      ? boundCards.cards
      : allCards.map((card) =>
          card.key.startsWith("sha256:") ? card : unboundInboxCard(card),
        );
  const coverage: InboxCoverage[] = [
    ...props.permission.coverage.map(
      (entry): InboxCoverage => ({
        sourceKind: "permission",
        state: entry.state,
        reason: entry.reason ?? "Permission source coverage is incomplete.",
      }),
    ),
    ...props.writeCoverage,
  ];
  const incompleteCoverage = coverage.filter(
    (entry) => entry.state !== "current",
  );
  const projection = projectInbox({
    cards: projectedCards,
    dispositions: props.dispositions,
    coverage,
    filters,
    now: new Date(now).toISOString(),
  });
  const notices = projection.notices;
  const actionableCards = projection.cards.filter((card) => !card.notice);
  const groups = new Map<string, { name: string; cards: InboxCard[] }>();
  for (const card of actionableCards) {
    const group = groups.get(card.projectId) ?? {
      name: card.projectName,
      cards: [],
    };
    group.cards.push(card);
    groups.set(card.projectId, group);
  }
  const selectedFilterLabel =
    filters.sourceKind === "all"
      ? "all item types"
      : filters.sourceKind.replaceAll("-", " ");
  const filtered = Boolean(filters.projectId || filters.sourceKind !== "all");
  const emptyTitle =
    filters.bucket === "snoozed"
      ? "No snoozed action cards"
      : filtered
        ? "No matching action cards"
        : incompleteCoverage.length > 0
          ? "No verified actions are available"
          : "No current actions in checked sources";
  const emptyHint = filtered
    ? "Clear filters to inspect other projects and source types; unavailable source rows and notices remain listed above."
    : incompleteCoverage.length > 0
      ? "Retained notices remain visible above. Retry when sources are available to refresh action authority."
      : "Available project, session, and retained-write sources were checked. Other source classes may not have reported yet.";
  const canAcknowledge = (card: InboxCard) =>
    card.sourceKind !== "permission" &&
    !card.permission &&
    props.dispositionWritable &&
    props.home?.catalog.projects.some(
      (project) => project.id === card.projectId && !project.archived,
    ) === true;

  return (
    <section class="af-inbox" aria-labelledby="af-inbox-title">
      <header class="af-inbox-heading">
        <div>
          <p class="af-inbox-eyebrow">Cross-project work queue</p>
          <h1 id="af-inbox-title">Inbox</h1>
          <p>
            Review verified requests and retained outcomes. Each source keeps
            its own authority.
          </p>
        </div>
        <Button onClick={props.onRetry} disabled={props.loading}>
          Refresh Inbox
        </Button>
      </header>

      {props.loading && (
        <div
          class="af-inbox-skeleton"
          role="status"
          aria-label="Loading Inbox sources"
        >
          <span />
          <span />
          <span />
          <p>
            Checking current sources… Previous verified rows stay visible while
            the refresh runs.
          </p>
        </div>
      )}
      {props.error && (
        <p role="alert" class="af-inbox-error">
          {props.error} Retry to check the current source again.
        </p>
      )}
      {props.permission.coverage.some((item) => item.state !== "current") && (
        <p role="status" class="af-inbox-stale">
          Some permission sources are unavailable or incomplete. Retained rows
          are not current action authority.
        </p>
      )}
      {incompleteCoverage.length > 0 && (
        <p role="status" class="af-inbox-stale">
          Some reported Inbox sources could not be verified. Their notices
          remain visible; source actions are held.
        </p>
      )}
      {props.dispositionError && (
        <p role="alert" class="af-inbox-error">
          {props.dispositionError} Source items remain visible.
        </p>
      )}
      {props.dispositionRefreshing && (
        <p role="status">Refreshing saved Inbox dispositions…</p>
      )}
      {props.dispositionLoading && (
        <p role="status">Checking this Inbox action…</p>
      )}

      {props.holds.length > 0 && (
        <section class="af-inbox-notices" aria-label="Inbox action history">
          <div class="af-inbox-section-heading">
            <div>
              <h2>Original Inbox actions to review</h2>
              <p>
                These exact app action records remain held. Review them by
                request id before clearing a reservation.
              </p>
            </div>
          </div>
          {props.holds.map((original) => {
            const history = props.history.find(
              (item) => item.original.requestId === original.requestId,
            );
            const checked = props.checkedOriginals.includes(original.requestId);
            const reserved =
              history?.receipt?.phase === "reserved" &&
              history.state === "persisted-reserved";
            return (
              <article class="af-inbox-notice" key={original.requestId}>
                <div>
                  <p class="af-inbox-card-meta">
                    {original.projectId} · {original.workspace}
                  </p>
                  <h3>
                    {original.item.sourceKind.replaceAll("-", " ")} ·{" "}
                    {original.operation}
                  </h3>
                  <p>
                    Request {original.requestId} · source revision{" "}
                    {original.item.sourceRevision} · {history?.state ?? "held"}
                  </p>
                  {history?.receipt && (
                    <p>
                      Server receipt: {history.receipt.phase}
                      {history.receipt.refusalReason
                        ? ` · ${history.receipt.refusalReason}`
                        : ""}
                    </p>
                  )}
                </div>
                <InboxDispositionHistoryActions
                  sourceKind={original.item.sourceKind}
                  requestId={original.requestId}
                  {...(history ? { state: history.state } : {})}
                  reserved={reserved}
                  checked={checked}
                  loading={props.dispositionLoading}
                  onCheck={props.onCheckOriginal}
                  onDiscard={props.onDiscardOriginal}
                  onReview={props.onReviewOriginal}
                />
              </article>
            );
          })}
        </section>
      )}

      {notices.length > 0 && (
        <section
          class="af-inbox-notices"
          aria-label="Retained bead write outcomes"
        >
          <div class="af-inbox-section-heading">
            <div>
              <h2>Write outcomes to check</h2>
              <p>
                Checking bead membership does not confirm whether an unknown
                write took effect.
              </p>
            </div>
          </div>
          {notices.map((card) => {
            const entry = props.dispositions.find(
              (item) =>
                item.projectId === card.projectId &&
                item.workspace === card.workspace &&
                item.item.sourceKind === card.sourceKind &&
                item.item.stableItemId === card.stableItemId &&
                item.item.sourceRevision === card.sourceRevision,
            );
            const until =
              entry?.operation === "snooze-1h" &&
              entry.snoozedUntil &&
              Date.parse(entry.snoozedUntil) > now
                ? entry.snoozedUntil
                : undefined;
            return (
              <article class="af-inbox-notice" key={card.key}>
                <div>
                  <p class="af-inbox-card-meta">
                    {card.projectName} ·{" "}
                    <strong>
                      {card.writePhase === "unknown"
                        ? "Outcome unknown"
                        : card.writePhase === "refused"
                          ? "Write refused"
                          : "Write completed"}
                    </strong>{" "}
                    ·{" "}
                    {card.sourceState === "current"
                      ? "source checked"
                      : "source unavailable"}
                  </p>
                  <h3>{card.title}</h3>
                  <p>{card.detail}</p>
                  {until && (
                    <p role="status">
                      Snoozed until{" "}
                      {new Date(until).toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      . This outcome notice remains visible.
                    </p>
                  )}
                </div>
                <div class="af-inbox-actions">
                  {card.checkHref && (
                    <a class="af-inbox-link" href={card.checkHref}>
                      Check {card.checkLabel ?? "source"}
                    </a>
                  )}
                  {card.canSnooze && (
                    <Button
                      disabled={
                        props.dispositionLoading || !canAcknowledge(card)
                      }
                      onClick={() =>
                        void props.onAcknowledge(card, "snooze-1h")
                      }
                    >
                      Snooze action for 1 hour
                    </Button>
                  )}
                  {card.unknownWriteKey && card.canCheck && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        void props.writes.client.checked(
                          card.unknownWriteKey ?? "",
                        )
                      }
                    >
                      I checked this write · dismiss
                    </Button>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      )}

      <section class="af-inbox-queue" aria-label="Inbox items">
        <div class="af-inbox-section-heading">
          <div>
            <h2>{filters.bucket === "needs-you" ? "Needs you" : "Snoozed"}</h2>
            <p>
              {projection.complete
                ? `${projection.visibleCount} items · ${selectedFilterLabel}`
                : `${projection.visibleCount} retained · ${projection.verifiedCount} source-checked · coverage is partial`}
            </p>
          </div>
        </div>
        <div class="af-inbox-filter-row">
          <div class="af-inbox-tabs" role="group" aria-label="Inbox bucket">
            <button
              type="button"
              aria-pressed={filters.bucket === "needs-you"}
              onClick={() => setFilters({ ...filters, bucket: "needs-you" })}
            >
              Needs you
            </button>
            <button
              type="button"
              aria-pressed={filters.bucket === "snoozed"}
              onClick={() => setFilters({ ...filters, bucket: "snoozed" })}
            >
              Snoozed
            </button>
          </div>
          <label>
            Project
            <select
              aria-label="Filter Inbox by project"
              value={filters.projectId}
              onChange={(event) =>
                setFilters({ ...filters, projectId: event.currentTarget.value })
              }
            >
              <option value="">All projects</option>
              {props.home?.catalog.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Item type
            <select
              aria-label="Filter Inbox by type"
              value={filters.sourceKind}
              onChange={(event) => {
                const value = event.currentTarget.value;
                const kind = INBOX_SOURCE_KINDS.find(
                  (candidate) => candidate === value,
                );
                setFilters({ ...filters, sourceKind: kind ?? "all" });
              }}
            >
              <option value="all">All types</option>
              {INBOX_SOURCE_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind.replaceAll("-", " ")}
                </option>
              ))}
            </select>
          </label>
          {(filters.projectId || filters.sourceKind !== "all") && (
            <Button
              variant="ghost"
              onClick={() =>
                setFilters({ ...filters, projectId: "", sourceKind: "all" })
              }
            >
              Clear filters
            </Button>
          )}
        </div>
        {projection.unreported.length > 0 && (
          <p role="status" class="af-inbox-coverage">
            Waiting count unavailable · {projection.unreported.length} source
            classes have not reported:{" "}
            {projection.unreported
              .map((kind) => kind.replaceAll("-", " "))
              .join(", ")}
            .
          </p>
        )}
        {!props.loading && actionableCards.length === 0 ? (
          <EmptyState title={emptyTitle} hint={emptyHint} live />
        ) : (
          [...groups.entries()].map(([projectId, group]) => (
            <section
              class="af-inbox-project"
              key={projectId}
              aria-label={group.name}
            >
              <h3>{group.name}</h3>
              {group.cards.map((card) => (
                <PermissionOrDispositionCard
                  key={card.key}
                  card={card}
                  props={props}
                  filters={filters}
                  canAcknowledge={canAcknowledge(card)}
                />
              ))}
            </section>
          ))
        )}
      </section>
    </section>
  );
}

export function InboxDispositionHistoryActions({
  sourceKind,
  requestId,
  state,
  reserved,
  checked,
  loading,
  onCheck,
  onDiscard,
  onReview,
}: {
  sourceKind: InboxSourceKind;
  requestId: string;
  state?: InboxDispositionHistory["state"];
  reserved: boolean;
  checked: boolean;
  loading: boolean;
  onCheck(requestId: string): Promise<boolean>;
  onDiscard(requestId: string): Promise<void>;
  onReview(requestId: string): Promise<void>;
}) {
  if (sourceKind === "permission")
    return (
      <p role="status">
        This original permission record remains retained and read-only.
      </p>
    );
  return (
    <div class="af-inbox-actions">
      <Button
        variant="ghost"
        disabled={loading}
        onClick={() => void onCheck(requestId)}
      >
        Check exact original
      </Button>
      {state === "reserve-unknown" && (
        <Button
          variant="ghost"
          disabled={loading}
          onClick={() => void onReview(requestId)}
        >
          Review unconfirmed reservation
        </Button>
      )}
      {reserved && (
        <Button
          variant="ghost"
          disabled={loading || !checked}
          {...(checked
            ? {}
            : {
                title:
                  "Check this exact original before discarding its reservation.",
              })}
          onClick={() => void onDiscard(requestId)}
        >
          Discard checked reservation
        </Button>
      )}
    </div>
  );
}

export function PermissionOrDispositionCard({
  card,
  props,
  filters,
  canAcknowledge,
}: {
  card: InboxCard;
  props: Pick<InboxProps, "dispositionLoading" | "onAcknowledge">;
  filters: InboxFilters;
  canAcknowledge: boolean;
}) {
  const permission = card.permission;
  const readOnlyPermission =
    card.sourceKind === "permission" || Boolean(permission);
  return (
    <article class="af-inbox-card" key={card.key}>
      <div class="af-inbox-card-copy">
        <p class="af-inbox-card-meta">
          {card.projectName} · {card.sourceKind.replaceAll("-", " ")} ·{" "}
          {card.sourceState === "current" ? "Current source" : "Check required"}
        </p>
        <h3>{card.title}</h3>
        <p>{card.detail}</p>
        {permission?.state === "current" &&
          permission.approval.provider === "codex" && (
            <dl class="af-inbox-request-details">
              <dt>Requested command</dt>
              <dd>
                <code>
                  {permission.approval.value.command ?? "Not provided"}
                </code>
              </dd>
              <dt>Working directory</dt>
              <dd>
                <code>{permission.approval.value.cwd ?? "Not provided"}</code>
              </dd>
              {permission.approval.value.reason && (
                <>
                  <dt>Reason</dt>
                  <dd>{permission.approval.value.reason}</dd>
                </>
              )}
            </dl>
          )}
        {permission?.state === "current" &&
          permission.approval.provider === "gemini" && (
            <details class="af-inbox-request-details">
              <summary>Review native permission details</summary>
              <pre>
                {permission.approval.value.detail.json}
                {permission.approval.value.detail.truncated
                  ? " (truncated)"
                  : ""}
              </pre>
              {!permission.approval.value.detailsComplete && (
                <p role="status">
                  Complete details are unavailable. This permission item remains
                  read-only.
                </p>
              )}
            </details>
          )}
        {permission?.state === "held" && (
          <p role="status">
            Original permission is held. No replacement decision will be sent.
          </p>
        )}
      </div>
      <div class="af-inbox-actions">
        {permission && (
          <a
            class="af-inbox-link"
            href={desktopHref({
              destination: "sessions",
              projectId: permission.projectId,
              selection: { kind: "session", id: permission.sessionId },
            })}
          >
            Open session
          </a>
        )}
        {!readOnlyPermission && card.canSnooze && (
          <Button
            variant="ghost"
            disabled={props.dispositionLoading || !canAcknowledge}
            onClick={() => void props.onAcknowledge(card, "snooze-1h")}
          >
            Snooze 1 hour
          </Button>
        )}
        {!readOnlyPermission &&
          (card.resolved ? (
            <Button
              disabled={props.dispositionLoading || !canAcknowledge}
              onClick={() => void props.onAcknowledge(card, "done")}
            >
              Mark done
            </Button>
          ) : (
            <Button
              disabled
              title="A fresh exact source join has not confirmed resolution."
            >
              Mark done · source unresolved
            </Button>
          ))}
        {filters.bucket === "snoozed" && card.checkHref && (
          <a class="af-inbox-link" href={card.checkHref}>
            Open source
          </a>
        )}
      </div>
    </article>
  );
}
