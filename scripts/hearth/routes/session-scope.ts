import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ConversationObject } from "../../../types/conversation";
import type { OwnedSessionMetadata } from "../../../types/owned-session";
import type { ClaudeSessionLaunch } from "../../../types/session-launch";
import { ConversationError } from "../../conversations/error";
import { selectProjectBeads, workspaceKey } from "../../projects/scope";
import { listWorktrees } from "../../scheduler/worktrees";
import { createSessionRegistry } from "../../sessions/registry";
import { localStateRoot } from "./dev-api";
import { keeperAboutValidator } from "./keeper-read";
import type { ReadDeps } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

function refuse(reason: string): never {
  throw new ConversationError(409, `${reason} No new turn was accepted.`);
}

/** Every mutable launch rechecks the current catalog and this hearth's Git registry. */
export function createSessionScopeValidator(
  home: string,
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
) {
  const validateAbout = keeperAboutValidator(deps, load);
  return async (
    projectId: string,
    metadata: OwnedSessionMetadata,
    about: ConversationObject[],
    launch?: ClaudeSessionLaunch,
  ): Promise<void> => {
    const snapshot = await load();
    const project = snapshot.catalog.projects.find(
      (item) => item.id === projectId,
    );
    if (!project)
      throw new ConversationError(
        404,
        "This project is not in the hearth catalog.",
      );
    if (project.archived)
      refuse("This project is archived. Restore it before starting work.");
    const scope = project.workspaces.find(
      (item) => workspaceKey(item.root) === workspaceKey(deps.workspace),
    );
    if (
      !scope ||
      workspaceKey(metadata.workspace) !== workspaceKey(deps.workspace)
    )
      refuse("This hearth does not serve the selected project workspace.");
    if (
      !scope.repositories.some(
        (path) => workspaceKey(path) === workspaceKey(metadata.repository),
      )
    )
      refuse("The repository is outside this project's current scope.");
    let main: string;
    try {
      main = realpathSync.native(localStateRoot(deps.root));
    } catch {
      refuse("The served repository is unavailable.");
    }
    if (workspaceKey(main) !== workspaceKey(metadata.repository))
      refuse(
        "Open the hearth for that repository before starting its session.",
      );
    const listed = listWorktrees(main, deps.git ? { git: deps.git } : {});
    if (!listed.ok)
      refuse(
        "The repository worktrees could not be verified. Refresh them before starting.",
      );
    const selected = listed.entries.find(
      (entry) =>
        !entry.missing &&
        workspaceKey(entry.path) === workspaceKey(metadata.worktree),
    );
    if (!selected)
      refuse(
        "The selected worktree is not in this repository's current Git registry.",
      );
    let canonical: string;
    try {
      if (!statSync(selected.path).isDirectory())
        refuse("The selected worktree is unavailable.");
      canonical = realpathSync.native(selected.path);
    } catch {
      refuse("The selected worktree is unavailable.");
    }
    if (launch?.extraDirectories)
      for (const path of launch.extraDirectories) {
        const candidate = workspaceKey(resolve(path)),
          root = workspaceKey(canonical);
        if (candidate !== root && !candidate.startsWith(`${root}/`))
          refuse("Extra directories must remain inside the checked worktree.");
        try {
          const actual = workspaceKey(realpathSync.native(path));
          if (
            !statSync(path).isDirectory() ||
            (actual !== root && !actual.startsWith(`${root}/`))
          )
            refuse(
              "An extra directory is linked outside the checked worktree.",
            );
        } catch {
          refuse(
            "An extra directory is unavailable or outside the checked worktree.",
          );
        }
      }
    if (
      metadata.beadId &&
      !selectProjectBeads(
        project,
        deps.workspace,
        snapshot.source.issues ?? [],
      ).some((bead) => bead.id === metadata.beadId)
    )
      refuse("The selected bead could not be confirmed in this project.");
    const ordinary: ConversationObject[] = [];
    for (const reference of about) {
      if (reference.kind === "session") {
        const owned = createSessionRegistry(home)
          .list(projectId)
          .find((record) => record.id === reference.id);
        if (
          owned &&
          workspaceKey(owned.workspace) === workspaceKey(deps.workspace) &&
          scope.repositories.some(
            (path) => workspaceKey(path) === workspaceKey(owned.repository),
          )
        )
          continue;
      }
      ordinary.push(reference);
    }
    if (ordinary.length) await validateAbout(projectId, ordinary);
  };
}
