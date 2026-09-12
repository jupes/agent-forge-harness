import type { ComponentChildren, JSX } from "preact";
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
 */
export function IssueDetailPanel({
  issue,
  ctx,
  onClose,
}: IssueDetailPanelProps): JSX.Element {
  const comments = commentsForIssue(issue.id, ctx.comments);
  const deps = depsTouchingIssue(issue.id, ctx.deps);
  const branches = workBranchesFromCommentBodies(comments);

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
            <Tag tone={statusTone(issue.status)}>
              {statusLabel(issue.status)}
            </Tag>
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
          {issue.assignee ? (
            <Row label="Assignee (claimed)">{issue.assignee}</Row>
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
            {comments.length > 0 ? (
              <ul class="af-detail-comments">
                {comments.map((comment: BeadsComment, index: number) => (
                  <li key={index}>
                    <p class="af-detail-comment-meta">
                      {comment.author} · {comment.createdAt}
                    </p>
                    <p class="af-detail-comment-body">{comment.body}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="af-muted">No comments in this export.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
