import type { JSX } from "preact";
import type {
  RepoEntry,
  ReposKnowledge,
  SharedConventions,
  WorktreeView,
} from "../../../scripts/dashboard/repos-knowledge-model";
import { Card } from "../ds/Card";
import { EmptyState } from "../ds/EmptyState";
import { Icon } from "../ds/Icon";
import { Table } from "../ds/Table";
import { Tag } from "../ds/Tag";
import { useDevApi } from "../use-dev-api";

const FRESHNESS_TONE = {
  current: "neutral",
  aging: "accent",
  stale: "outline",
  missing: "muted",
  archived: "muted",
} as const;

function freshnessLabel(repo: RepoEntry): string {
  if (repo.knowledgeAgeDays === null) return "no knowledge file";
  if (repo.knowledgeAgeDays === 0) return "updated today";
  return `${repo.knowledgeAgeDays}d old`;
}

/**
 * Registered sub-repositories, knowledge freshness, shared conventions and
 * worktrees.
 *
 * Reads `repos/repos.json`, `repos/`, `knowledge/` and the worktree registry
 * (`git worktree list` and `trees/.state.json`) through the dev-only API — all
 * of it local, none of it committed.
 */
export function ReposIsland(): JSX.Element {
  const { data, error, loading } =
    useDevApi<ReposKnowledge>("/repos-knowledge");

  if (loading) return <EmptyState title="Reading repos and knowledge…" live />;

  if (error) {
    return (
      <EmptyState
        title="Repos & knowledge needs the local dashboard"
        hint={
          <>
            This view reads <code>repos/</code>, <code>knowledge/</code> and{" "}
            <code>trees/</code> from the machine running the harness. Start{" "}
            <code>bun run dashboard</code> at the harness root and open this
            page on its local address.
          </>
        }
      />
    );
  }

  if (!data) return <EmptyState title="No repo state available" />;

  return (
    <>
      {data.localStateFrom ? (
        <p class="af-notice">
          This dashboard is running in a linked worktree. Repositories,
          knowledge files and worktrees are read from the main checkout at{" "}
          <code>{data.localStateFrom}</code>; shared conventions come from this
          branch.
        </p>
      ) : null}

      <Card
        title="Registered repositories"
        headingLevel={2}
        kicker="repos/repos.json"
      >
        <Table
          label="Registered repositories"
          rows={data.repos}
          rowKey={(repo) => repo.name}
          empty="No sub-repos registered yet. /add-repo <url> registers one."
          columns={[
            {
              key: "name",
              header: "Repository",
              cell: (repo) => (
                <>
                  <span class="af-issue-title">
                    {repo.name}
                    {repo.archived ? (
                      <>
                        {" "}
                        <Tag
                          tone="muted"
                          title="Archived in repos.json: bun run repo and /sync-knowledge --all skip it"
                        >
                          archived
                        </Tag>
                      </>
                    ) : null}
                  </span>
                  <span class="af-issue-blocked">{repo.path}</span>
                </>
              ),
            },
            {
              key: "defaultBranch",
              header: "Branch",
              cell: (repo) =>
                repo.defaultBranch ? (
                  <code>{repo.defaultBranch}</code>
                ) : (
                  <span class="af-muted">—</span>
                ),
            },
            {
              key: "cloned",
              header: "Clone",
              cell: (repo) => (
                <Tag tone={repo.cloned ? "neutral" : "muted"}>
                  {repo.cloned ? "cloned" : "not cloned"}
                </Tag>
              ),
            },
            {
              key: "knowledge",
              header: "Knowledge YAML",
              cell: (repo) => (
                <Tag tone={FRESHNESS_TONE[repo.freshness]}>
                  {repo.freshness === "stale" ? (
                    <Icon name="warning-circle" size={12} />
                  ) : null}
                  {freshnessLabel(repo)}
                </Tag>
              ),
            },
          ]}
        />
        <p class="af-muted af-prose">
          Refresh a repo's knowledge file with <code>/sync-knowledge</code>.
          Files older than 30 days are marked stale, except an archived
          repository's: <code>/sync-knowledge --all</code> skips it, so its file
          is not expected to be refreshed.
        </p>
      </Card>

      <ConventionsCard conventions={data.conventions} />

      <WorktreesCard worktrees={data.worktrees} error={data.worktreesError} />
    </>
  );
}

function ConventionsCard({
  conventions,
}: {
  conventions: SharedConventions | null;
}): JSX.Element {
  if (!conventions) {
    return (
      <Card title="Shared conventions" headingLevel={2}>
        <p class="af-prose af-muted">
          No <code>knowledge/_shared.yaml</code> found at the harness root.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="Shared conventions"
      headingLevel={2}
      kicker={conventions.source}
    >
      {conventions.error ? (
        <p class="af-notice af-notice-error" role="alert">
          Could not parse {conventions.source}: {conventions.error}
        </p>
      ) : (
        <Table
          label="Shared conventions"
          rows={conventions.entries}
          rowKey={(entry) => entry.key}
          empty="The file has no shared_conventions block."
          columns={[
            {
              key: "key",
              header: "Convention",
              class: "af-col-command",
              cell: (entry) => <code>{entry.key}</code>,
            },
            {
              key: "value",
              header: "Value",
              cell: (entry) => (
                <span class="af-convention-value">{entry.value}</span>
              ),
            },
          ]}
        />
      )}
      <p class="af-muted af-prose">
        Agents load these alongside each repo's own YAML. Query them with{" "}
        <code>/ask</code>.
      </p>
    </Card>
  );
}

const KIND_LABEL = {
  main: "main checkout",
  trees: "trees/",
  claude: "desktop app",
  other: "elsewhere",
} as const;

function worktreeState(worktree: WorktreeView): JSX.Element {
  if (worktree.missing || !worktree.pathExists)
    return (
      <Tag tone="outline">
        <Icon name="warning-circle" size={12} />
        missing
      </Tag>
    );
  if (worktree.locked) return <Tag tone="accent">locked</Tag>;
  if (worktree.prunable) return <Tag tone="outline">prunable</Tag>;
  return <Tag tone="neutral">present</Tag>;
}

const none = <span class="af-muted">—</span>;

/** Every worktree of the repository, with the bead it serves and the session in it. */
function WorktreesCard({
  worktrees,
  error,
}: {
  worktrees: WorktreeView[];
  error: string | null;
}): JSX.Element {
  return (
    <Card title="Worktrees" headingLevel={2} kicker="git worktree list">
      {error ? (
        <p class="af-notice">The worktrees could not be listed: {error}</p>
      ) : null}
      <Table
        label="Worktrees"
        rows={worktrees}
        rowKey={(worktree) => worktree.path}
        empty="No worktrees. bun run worktree create <branch> adds one."
        columns={[
          {
            key: "branch",
            header: "Branch",
            cell: (worktree) => (
              <span class="af-type">
                <Icon name="git-branch" size={13} />
                <code>
                  {worktree.branch ??
                    `detached ${(worktree.head ?? "").slice(0, 7)}`}
                </code>
              </span>
            ),
          },
          {
            key: "kind",
            header: "Kind",
            cell: (worktree) => KIND_LABEL[worktree.kind],
          },
          {
            key: "beadId",
            header: "Bead",
            cell: (worktree) =>
              worktree.beadId ? <code>{worktree.beadId}</code> : none,
          },
          {
            key: "sessionId",
            header: "Session",
            cell: (worktree) =>
              worktree.sessionId ? <code>{worktree.sessionId}</code> : none,
          },
          {
            key: "path",
            header: "Path",
            cell: (worktree) => (
              <span class="af-muted">
                {worktree.path}
                {worktree.id ? (
                  <>
                    {" "}
                    · id <code>{worktree.id}</code>
                  </>
                ) : null}
              </span>
            ),
          },
          {
            key: "createdAt",
            header: "Created",
            class: "af-col-date",
            cell: (worktree) =>
              worktree.createdAt
                ? new Date(worktree.createdAt).toLocaleString()
                : none,
          },
          {
            key: "state",
            header: "State",
            cell: worktreeState,
          },
        ]}
      />
      <p class="af-muted af-prose">
        A worktree with an id was made by <code>bun run worktree create</code>;{" "}
        <code>bun run worktree cleanup &lt;id&gt;</code> removes it, and keeps
        one with changes unless given <code>--force</code>. The others (the main
        checkout, the desktop app's) are listed only. The stash is one stack
        shared by every worktree: never a bare <code>git stash pop</code>.
      </p>
    </Card>
  );
}
