import type { JSX } from "preact";
import type { RepoEntry } from "../../../scripts/dashboard/repos-knowledge-model";
import { Card } from "../ds/Card";
import { EmptyState } from "../ds/EmptyState";
import { Icon } from "../ds/Icon";
import { Table } from "../ds/Table";
import { Tag } from "../ds/Tag";
import { useDevApi } from "../use-dev-api";

interface ReposPayload {
  repos: RepoEntry[];
  sharedKnowledge: string | null;
}

const FRESHNESS_TONE = {
  current: "neutral",
  aging: "accent",
  stale: "outline",
  missing: "muted",
} as const;

function freshnessLabel(repo: RepoEntry): string {
  if (repo.knowledgeAgeDays === null) return "no knowledge file";
  if (repo.knowledgeAgeDays === 0) return "updated today";
  return `${repo.knowledgeAgeDays}d old`;
}

/**
 * Registered sub-repositories and the freshness of their knowledge files.
 *
 * Reads `repos/repos.json`, the `repos/` directory and `knowledge/repos/`
 * through the dev-only API — all of it local, none of it committed.
 */
export function ReposIsland(): JSX.Element {
  const { data, error, loading } = useDevApi<ReposPayload>("/repos-knowledge");

  if (loading) return <EmptyState title="Reading repos and knowledge…" live />;

  if (error) {
    return (
      <EmptyState
        title="Repos & knowledge needs the local dashboard"
        hint={
          <>
            This view reads <code>repos/</code> and <code>knowledge/</code> from
            the machine running the harness. Start{" "}
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
                  <span class="af-issue-title">{repo.name}</span>
                  <span class="af-issue-blocked">{repo.path}</span>
                </>
              ),
            },
            {
              key: "branch",
              header: "Branch",
              cell: (repo) =>
                repo.branch ? (
                  <code>{repo.branch}</code>
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
          Files older than 30 days are marked stale.
        </p>
      </Card>

      <Card
        title="Shared conventions"
        headingLevel={2}
        kicker={data.sharedKnowledge ?? "not found"}
      >
        {data.sharedKnowledge ? (
          <p class="af-prose af-muted">
            Cross-repo conventions — commit format, branch naming, PR
            requirements, testing standards and code standards — live in{" "}
            <code>{data.sharedKnowledge}</code> and are loaded by agents
            alongside each repo's own YAML. Query them with <code>/ask</code>.
          </p>
        ) : (
          <p class="af-prose af-muted">
            No <code>knowledge/_shared.yaml</code> found at the harness root.
          </p>
        )}
      </Card>
    </>
  );
}
