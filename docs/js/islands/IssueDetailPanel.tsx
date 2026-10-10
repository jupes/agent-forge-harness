import type { ComponentChildren, JSX } from "preact";
import { useEffect } from "preact/hooks";
import type {
  BeadsComment,
  BeadsDependency,
  BeadsIssue,
} from "../../../types/beads";
import { Button } from "../ds/Button";
import { Tag } from "../ds/Tag";
import {
  commentsForIssue,
  depsTouchingIssue,
  workBranchesFromCommentBodies,
} from "../issue-detail.mjs";
import { priorityTone, statusLabel, statusTone } from "../issue-presentation";
import { BeadActions } from "./BeadActions";
import { applied, useApplied } from "./bead-writes";
import { CopyIdButton } from "./CopyIdButton";

export type IssueDetailCtx = {
  comments?: BeadsComment[];
  deps?: BeadsDependency[];
};

export type IssueDetailPanelProps = {
  issue: BeadsIssue;
  ctx: IssueDetailCtx;
  onClose: () => void;
};

function Row({
  label,
  children,
}: {
  label: string;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <div class="af-detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The expanded row body for an issue.
 *
 * Values are rendered as JSX text, which Preact escapes. The previous version
 * also ran them through `escapeHtml()` first, so anything containing `&`, `<`
 * or `>` reached the screen double-escaped (`a &amp; b`).
 *
 * The issue comes from the snapshot, which a write does not rebuild. What the
 * actions taken on this page changed (as `bd` answered) is shown over it and
 * marked as such, until the snapshot's issue says the same or has changed
 * since. The row above the panel and the lists stay the snapshot's.
 */
export function IssueDetailPanel({
  issue,
  ctx,
  onClose,
}: IssueDetailPanelProps): JSX.Element {
  const comments = commentsForIssue(issue.id, ctx.comments);
  const deps = depsTouchingIssue(issue.id, ctx.deps);
  const branches = workBranchesFromCommentBodies(comments);

  const mine = useApplied(issue.id);
  // Whenever the snapshot's view of this issue changes, drop what it now says
  // itself, and what it has since contradicted.
  const commentBodies = JSON.stringify(
    comments.map((comment: BeadsComment) => comment.body),
  );
  // `comments` is a new array on every render; its bodies are what this depends on.
  useEffect(() => {
    applied.reconcile(issue.id, {
      status: issue.status,
      updatedAt: issue.updatedAt,
      comments,
    });
  }, [issue.id, issue.status, issue.updatedAt, commentBodies]);
  const status = mine?.status ?? issue.status;
  const assignee = mine?.assignee ?? issue.assignee;
  const added = mine?.comments ?? [];
  const FROM_HERE = "from your actions on this page";

  return (
    <div class="af-detail">
      <div class="af-detail-toolbar">
        <p class="af-section-label">Issue details</p>
        <Button
          variant="ghost"
          icon="x"
          aria-label="Close expanded issue"
          onClick={onClose}
        />
      </div>

      <div class="af-detail-grid">
        <dl class="af-detail-facts">
          <Row label="ID">
            <CopyIdButton issueId={issue.id} />
          </Row>
          {issue.type ? <Row label="Type">{issue.type}</Row> : null}
          <Row label="Title">{issue.title}</Row>
          <Row label="Status">
            <Tag tone={statusTone(status)}>{statusLabel(status)}</Tag>
            {mine?.status !== undefined && mine.status !== issue.status ? (
              <span class="af-muted af-bead-from-here">
                {" "}
                {FROM_HERE}; the snapshot says {statusLabel(issue.status)}
              </span>
            ) : null}
          </Row>
          {issue.priority ? (
            <Row label="Priority">
              <Tag tone={priorityTone(issue.priority)}>{issue.priority}</Tag>
            </Row>
          ) : null}
          {issue.parent ? (
            <Row label="Parent">
              <CopyIdButton issueId={issue.parent} />
            </Row>
          ) : null}
          {issue.repo ? <Row label="Repo">{issue.repo}</Row> : null}
          {issue.due ? <Row label="Due">{issue.due}</Row> : null}
          {issue.createdAt ? (
            <Row label="Created">{issue.createdAt}</Row>
          ) : null}
          {issue.updatedAt ? (
            <Row label="Updated">{issue.updatedAt}</Row>
          ) : null}
          {issue.owner ? <Row label="Owner">{issue.owner}</Row> : null}
          {assignee ? (
            <Row label="Assignee (claimed)">
              {assignee}
              {mine?.assignee !== undefined &&
              mine.assignee !== issue.assignee ? (
                <span class="af-muted af-bead-from-here"> {FROM_HERE}</span>
              ) : null}
            </Row>
          ) : null}
          {issue.labels && issue.labels.length > 0 ? (
            <Row label="Labels">
              <span class="af-detail-tags">
                {issue.labels.map((label) => (
                  <Tag key={label} tone="muted">
                    {label}
                  </Tag>
                ))}
              </span>
            </Row>
          ) : null}
          {issue.estimate != null ? (
            <Row label="Estimate (min)">{issue.estimate}</Row>
          ) : null}
          {issue.spent != null ? (
            <Row label="Spent (min)">{issue.spent}</Row>
          ) : null}
          {issue.closedBy ? (
            <Row label="Closed by">{issue.closedBy}</Row>
          ) : null}
        </dl>

        <div class="af-detail-prose-col">
          {issue.ac && issue.ac.length > 0 ? (
            <section>
              <p class="af-section-label">Acceptance criteria</p>
              <ul class="af-detail-ac">
                {issue.ac.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {issue.description ? (
            <section>
              <p class="af-section-label">Description</p>
              <p class="af-detail-prose">{issue.description}</p>
            </section>
          ) : null}

          {branches.length > 0 ? (
            <section>
              <p class="af-section-label">Work branches (from comments)</p>
              <ul class="af-detail-list">
                {branches.map((branch: string) => (
                  <li key={branch}>
                    <code>{branch}</code>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {deps.length > 0 ? (
            <section>
              <p class="af-section-label">Dependencies</p>
              <ul class="af-detail-list">
                {deps.map((dep: BeadsDependency, index: number) => {
                  const blockedByThis = dep.from === issue.id;
                  return (
                    <li key={index}>
                      <span class="af-muted">
                        {blockedByThis ? "Blocked by" : "Blocks"}
                      </span>{" "}
                      <code>{blockedByThis ? dep.to : dep.from}</code>{" "}
                      <span class="af-muted">({dep.type})</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          <section>
            <p class="af-section-label">Comments</p>
            {comments.length > 0 || added.length > 0 ? (
              <ul class="af-detail-comments">
                {comments.map((comment: BeadsComment, index: number) => (
                  <li key={index}>
                    <p class="af-detail-comment-meta">
                      {comment.author} · {comment.createdAt}
                    </p>
                    <p class="af-detail-comment-body">{comment.body}</p>
                  </li>
                ))}
                {added.map((comment) => (
                  <li key={comment.id} class="af-bead-added-comment">
                    <p class="af-detail-comment-meta">
                      {comment.author} · {comment.createdAt} · {FROM_HERE}
                    </p>
                    <p class="af-detail-comment-body">{comment.text}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="af-muted">No comments in this export.</p>
            )}
          </section>

          <BeadActions id={issue.id} status={status} />
          <p class="af-muted af-prose af-bead-snapshot-note">
            The row above and the issue lists are a snapshot of the tracker. A
            change made here is shown in this panel from what <code>bd</code>{" "}
            answered; the lists show it once the snapshot has been rebuilt from
            the tracker.
          </p>
        </div>
      </div>
    </div>
  );
}
