import type { ComponentChildren } from "preact";
import type {
  BeadsComment,
  BeadsDependency,
  BeadsIssue,
} from "../../../types/beads";
import {
  commentsForIssue,
  depsTouchingIssue,
  escapeHtml,
  issueIdCopyControlHtml,
  workBranchesFromCommentBodies,
} from "../issue-detail.mjs";

export type IssueDetailCtx = {
  comments?: BeadsComment[];
  deps?: BeadsDependency[];
};

export type IssueDetailPanelProps = {
  issue: BeadsIssue;
  ctx: IssueDetailCtx;
  onClose: () => void;
};

function DdHtml({ html }: { html: string }) {
  return <dd dangerouslySetInnerHTML={{ __html: html }} />;
}

function KvRow({
  label,
  children,
}: {
  label: string;
  children: ComponentChildren;
}) {
  return (
    <div className="issue-detail-kv">
      <dt>{escapeHtml(label)}</dt>
      {children}
    </div>
  );
}

export function IssueDetailPanel({
  issue,
  ctx,
  onClose,
}: IssueDetailPanelProps) {
  const comments = commentsForIssue(issue.id, ctx.comments);
  const deps = depsTouchingIssue(issue.id, ctx.deps);
  const branches = workBranchesFromCommentBodies(comments);

  return (
    <div className="issue-detail-panel">
      <div className="issue-detail-toolbar">
        <span className="issue-detail-heading">Issue details</span>
        <button
          type="button"
          className="issue-detail-close"
          aria-label="Close expanded issue"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="issue-detail-dl-wrap">
        <KvRow label="ID">
          <DdHtml html={issueIdCopyControlHtml(issue.id)} />
        </KvRow>
        {issue.type ? (
          <KvRow label="Type">
            <dd>{escapeHtml(String(issue.type))}</dd>
          </KvRow>
        ) : null}
        <KvRow label="Title">
          <dd>{escapeHtml(String(issue.title ?? ""))}</dd>
        </KvRow>
        <KvRow label="Status">
          <dd>{escapeHtml(String(issue.status ?? ""))}</dd>
        </KvRow>
        {issue.priority ? (
          <KvRow label="Priority">
            <dd>{escapeHtml(String(issue.priority))}</dd>
          </KvRow>
        ) : null}
        {issue.parent ? (
          <KvRow label="Parent">
            <DdHtml html={issueIdCopyControlHtml(issue.parent)} />
          </KvRow>
        ) : null}
        {issue.repo ? (
          <KvRow label="Repo">
            <dd>{escapeHtml(String(issue.repo))}</dd>
          </KvRow>
        ) : null}
        {issue.due ? (
          <KvRow label="Due">
            <dd>{escapeHtml(String(issue.due))}</dd>
          </KvRow>
        ) : null}
        {issue.createdAt ? (
          <KvRow label="Created">
            <dd>{escapeHtml(String(issue.createdAt))}</dd>
          </KvRow>
        ) : null}
        {issue.updatedAt ? (
          <KvRow label="Updated">
            <dd>{escapeHtml(String(issue.updatedAt))}</dd>
          </KvRow>
        ) : null}
        {issue.owner ? (
          <KvRow label="Owner">
            <dd>{escapeHtml(String(issue.owner))}</dd>
          </KvRow>
        ) : null}
        {issue.assignee ? (
          <KvRow label="Assignee (claimed)">
            <dd>{escapeHtml(String(issue.assignee))}</dd>
          </KvRow>
        ) : null}
        {Array.isArray(issue.labels) && issue.labels.length > 0 ? (
          <KvRow label="Labels">
            <dd>{issue.labels.map((l) => escapeHtml(String(l))).join(", ")}</dd>
          </KvRow>
        ) : null}
        {Array.isArray(issue.ac) && issue.ac.length > 0 ? (
          <KvRow label="AC">
            <dd>
              <ul className="issue-detail-ac">
                {issue.ac.map((line, idx) => (
                  <li key={idx}>{escapeHtml(String(line))}</li>
                ))}
              </ul>
            </dd>
          </KvRow>
        ) : null}
        {issue.estimate != null ? (
          <KvRow label="Estimate (min)">
            <dd>{escapeHtml(String(issue.estimate))}</dd>
          </KvRow>
        ) : null}
        {issue.spent != null ? (
          <KvRow label="Spent (min)">
            <dd>{escapeHtml(String(issue.spent))}</dd>
          </KvRow>
        ) : null}
        {issue.closedBy ? (
          <KvRow label="Closed by">
            <dd>{escapeHtml(String(issue.closedBy))}</dd>
          </KvRow>
        ) : null}
        {issue.description ? (
          <KvRow label="Description / AC text">
            <dd>
              <div className="issue-detail-prose">
                {escapeHtml(String(issue.description))}
              </div>
            </dd>
          </KvRow>
        ) : null}
      </div>

      {branches.length > 0 ? (
        <section className="issue-detail-section">
          <h5>Work branches (from comments)</h5>
          <ul className="issue-detail-branches">
            {branches.map((b: string) => (
              <li key={b}>
                <code>{escapeHtml(b)}</code>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="issue-detail-section">
        <h5>Comments</h5>
        {comments.length > 0 ? (
          <ul className="issue-detail-comments">
            {comments.map((c: BeadsComment, idx: number) => (
              <li key={idx}>
                <span className="issue-detail-meta">
                  {escapeHtml(String(c.author || ""))} ·{" "}
                  {escapeHtml(String(c.createdAt || ""))}
                </span>
                <pre className="issue-detail-comment-body">
                  {escapeHtml(String(c.body || ""))}
                </pre>
              </li>
            ))}
          </ul>
        ) : (
          <p className="issue-detail-empty">No comments in this export.</p>
        )}
      </section>

      {deps.length > 0 ? (
        <section className="issue-detail-section">
          <h5>Dependencies</h5>
          <ul className="issue-detail-deps">
            {deps.map((d: BeadsDependency, idx: number) => {
              const rel = d.from === issue.id ? "Blocked by" : "Blocks";
              const other = d.from === issue.id ? d.to : d.from;
              return (
                <li key={idx}>
                  <span className="issue-detail-dep-rel">
                    {escapeHtml(rel)}
                  </span>{" "}
                  <code>{escapeHtml(String(other))}</code>{" "}
                  <span className="issue-detail-dep-type">
                    ({escapeHtml(String(d.type || ""))})
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
