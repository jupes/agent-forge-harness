import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCheckout } from "../../scripts/ledger/workspace";
import { projectFixture } from "../../scripts/projects/testing";
import type { ProjectCatalog } from "../../types/projects";
import { withStateLock, writeState } from "../e2e/bd-stand-in-state";
import { BD_STAND_IN_STATE, bunPath, HEARTH_HOME } from "../e2e/servers";

export const catalogFile = join(HEARTH_HOME, "projects", "catalog.json");
export const workspace = resolveCheckout(process.cwd()).workspace;
export const alpha = projectFixture(workspace);
export const beta = projectFixture(workspace, {
  id: "project-b5832fa0-7a21-403b-8184-44892f0d8d86",
  slug: "beta",
  name: "Beta",
  workspaces: [
    { root: workspace, repositories: [workspace], epicIds: ["beta-epic"] },
  ],
});
export const catalog: ProjectCatalog = {
  version: 1,
  revision: 1,
  projects: [alpha, beta],
};
export function seedProjects(): void {
  mkdirSync(join(HEARTH_HOME, "projects"), { recursive: true });
  writeFileSync(catalogFile, JSON.stringify(catalog));
  withStateLock(BD_STAND_IN_STATE, () =>
    writeState(
      BD_STAND_IN_STATE,
      Object.fromEntries(
        [alpha, beta].map((project) => [
          `${project.slug}-epic`,
          {
            id: `${project.slug}-epic`,
            title: `${project.name} epic`,
            issue_type: "epic",
            status: "open",
            priority: 2,
            created_at: project.createdAt,
            updated_at: project.updatedAt,
            labels: [`project:${project.slug}`],
          },
        ]),
      ),
    ),
  );
}

/** Only metadata in the run's isolated ledger; no provider or tracker process is started. */
export function seedSessions(): void {
  const result = spawnSync(
    bunPath(),
    [
      "-e",
      `import { appendEvent } from "./scripts/ledger/append";
    const workspace = process.argv[1];
    for (const [sessionId, beadId, parent] of [["e2e-alpha-parent", "alpha-epic", null], ["e2e-alpha-child", "alpha-epic", "e2e-alpha-parent"], ["e2e-beta-own", "beta-epic", null]]) {
      const result = appendEvent({kind:"session.started",workspace,beadId,sessionId,executor:{provider:"codex",model:"fixture-model",smith:"fixture-smith"},payload:{kind:parent ? "subagent" : "interactive",...(parent ? {parentSessionId:parent}: {})}});
      if (!result.ok) throw new Error(result.error);
    }`,
      workspace,
    ],
    {
      env: { ...process.env, AGENT_FORGE_HOME: HEARTH_HOME },
      encoding: "utf8",
      timeout: 10_000,
    },
  );
  if (result.status !== 0)
    throw new Error(`Isolated session fixture failed: ${result.stderr}`);
}
