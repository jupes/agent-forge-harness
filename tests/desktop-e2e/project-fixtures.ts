import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCheckout } from "../../scripts/ledger/workspace";
import { projectFixture } from "../../scripts/projects/testing";
import type { ProjectCatalog } from "../../types/projects";
import type { ConversationEvent } from "../../types/conversation";
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

/** A recorded private conversation fixture, written by the real guarded store; never a model turn. */
export function seedKeeper(events: Exclude<ConversationEvent, { kind: "user" }>[]): void {
  const result = spawnSync(bunPath(), ["-e", `
    import { randomUUID } from "node:crypto";
    import { createConversationStore } from "./scripts/conversations/store";
    import { eventSchema } from "./scripts/conversations/protocol";
    let raw; try { raw=JSON.parse(process.argv[2]); } catch { throw new Error("Invalid private conversation fixture"); }
    if (!Array.isArray(raw)) throw new Error("Expected event fixtures");
    const store=createConversationStore(process.env.AGENT_FORGE_HOME);
    const id=process.argv[1], requestId=randomUUID(), owner=randomUUID();
    await store.accept(id,{requestId,expectedRevision:0,text:"Recorded fixture question",about:[]});
    await store.start(id,requestId,owner);
    await store.append(id,requestId,owner,{kind:"identity",provider:"claude",sessionId:randomUUID(),version:"recorded-fixture"});
    for (const event of raw) { const parsed=eventSchema.parse(event); if(parsed.kind==="user")throw new Error("Unexpected fixture user event");await store.append(id,requestId,owner,parsed); }
    await store.finish(id,requestId,owner,"completed",null);
  `, alpha.id, JSON.stringify(events)], { env: { ...process.env, AGENT_FORGE_HOME: HEARTH_HOME }, encoding: "utf8", timeout: 15_000 });
  if (result.status !== 0) throw new Error(`Private conversation fixture failed: ${result.stderr}`);
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
