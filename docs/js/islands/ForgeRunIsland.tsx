import type { JSX } from "preact";
import type { ForgeRunSnapshot } from "../../../scripts/dashboard/forge-run-model";
import { Card } from "../ds/Card";
import { EmptyState } from "../ds/EmptyState";
import { Icon, type IconName } from "../ds/Icon";
import { Table } from "../ds/Table";
import { Tag } from "../ds/Tag";
import { useDevApi } from "../use-dev-api";

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

/**
 * The active Forge pipeline run.
 *
 * Reads this machine's own `.tmp/work/forge-state.json` and worktree records
 * through the dev-only API, so it shows the real run rather than a mock.
 */
export function ForgeRunIsland(): JSX.Element {
  const { data, error, loading } = useDevApi<ForgeRunSnapshot>("/forge-run");

  if (loading) return <EmptyState title="Reading forge state…" live />;

  if (error) {
    return (
      <EmptyState
        title="Forge run needs the local dashboard"
        hint={
          <>
            This view reads <code>.tmp/work/forge-state.json</code> from the
            machine running the harness. Start <code>bun run dashboard</code> at
            the harness root and open this page on its local address.
          </>
        }
      />
    );
  }

  if (!data) return <EmptyState title="No forge state available" />;

  return (
    <>
      {data.slug ? (
        <Card
          kicker="active run"
          title={data.slug}
          headingLevel={2}
          actions={data.epic ? <Tag tone="accent">{data.epic}</Tag> : undefined}
        >
          {data.feature ? <p class="af-prose">{data.feature}</p> : null}
          {data.updatedAt ? (
            <p class="af-muted">
              State last written {new Date(data.updatedAt).toLocaleString()}
            </p>
          ) : null}
        </Card>
      ) : (
        <EmptyState
          title="No forge run in flight"
          hint={
            <>
              Start one with <code>/forgemaster &lt;feature&gt;</code>. The four
              phases below unlock in order.
            </>
          }
        />
      )}

      <div class="af-phase-list">
        {data.phases.map((phase) => (
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

      <Card title="Worktrees" headingLevel={2} kicker="trees/.state.json">
        <Table
          label="Registered worktrees"
          rows={data.worktrees}
          rowKey={(worktree) => worktree.id}
          empty="No worktrees registered. bun run worktree create <branch> adds one."
          columns={[
            {
              key: "branch",
              header: "Branch",
              cell: (worktree) => <code>{worktree.branch}</code>,
            },
            { key: "id", header: "Id", class: "af-col-id" },
            {
              key: "path",
              header: "Path",
              cell: (worktree) => <span class="af-muted">{worktree.path}</span>,
            },
            {
              key: "createdAt",
              header: "Created",
              class: "af-col-date",
              cell: (worktree) => new Date(worktree.createdAt).toLocaleString(),
            },
          ]}
        />
      </Card>
    </>
  );
}
