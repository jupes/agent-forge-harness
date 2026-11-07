import { realpathSync, statSync } from "node:fs";
import type { ConversationObject } from "../../../types/conversation";
import type { OwnedSessionMetadata } from "../../../types/owned-session";
import type { ClaudeSessionLaunch } from "../../../types/session-launch";
import { ConversationError } from "../../conversations/error";
import { selectProjectBeads } from "../../projects/scope";
import { listWorktrees, registryPathKey } from "../../scheduler/worktrees";
import {
  createSessionRegistry,
  sameSessionFilesystemPath,
} from "../../sessions/registry";
import { localStateRoot } from "./dev-api";
import { keeperAboutValidator } from "./keeper-read";
import type { ReadDeps } from "./operator-reads";
import type { ProjectSnapshot } from "./project-summaries";

function refuse(reason: string): never {
  throw new ConversationError(409, `${reason} No new turn was accepted.`);
}

export function sessionFilesystemContains(
  root: string,
  path: string,
  platform: "win32" | "posix" = process.platform === "win32"
    ? "win32"
    : "posix",
): boolean {
  const parent = registryPathKey(root, platform),
    candidate = registryPathKey(path, platform),
    separator = platform === "win32" ? "\\" : "/",
    boundary = parent.endsWith(separator) ? parent : parent + separator;
  return candidate === parent || candidate.startsWith(boundary);
}

/** Shared current project/repository authority for Start and explicit worktree creation. */
export function createSessionRepositoryScopeValidator(
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
) {
  return async (
    projectId: string,
    metadata: Pick<OwnedSessionMetadata, "workspace" | "repository" | "beadId">,
  ) => {
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
    const scope = project.workspaces.find((item) =>
      sameSessionFilesystemPath(item.root, deps.workspace),
    );
    if (
      !scope ||
      !sameSessionFilesystemPath(metadata.workspace, deps.workspace)
    )
      refuse("This hearth does not serve the selected project workspace.");
    if (
      !scope.repositories.some((path) =>
        sameSessionFilesystemPath(path, metadata.repository),
      )
    )
      refuse("The repository is outside this project's current scope.");
    let main: string;
    try {
      main = realpathSync.native(localStateRoot(deps.root));
    } catch {
      refuse("The served repository is unavailable.");
    }
    if (!sameSessionFilesystemPath(main, metadata.repository))
      refuse(
        "Open the hearth for that repository before starting its session.",
      );
    if (
      metadata.beadId &&
      !selectProjectBeads(
        project,
        deps.workspace,
        snapshot.source.issues ?? [],
      ).some((bead) => bead.id === metadata.beadId)
    )
      refuse("The selected bead could not be confirmed in this project.");
    return { project, scope, repository: main };
  };
}

/** Every mutable launch rechecks the current catalog and this hearth's Git registry. */
export function createSessionScopeValidator(
  home: string,
  deps: ReadDeps,
  load: () => Promise<ProjectSnapshot>,
) {
  const validateAbout = keeperAboutValidator(deps, load);
  const repositoryScope = createSessionRepositoryScopeValidator(deps, load);
  return async (
    projectId: string,
    metadata: Pick<
      OwnedSessionMetadata,
      "workspace" | "repository" | "worktree" | "beadId"
    >,
    about: ConversationObject[],
    launch?: ClaudeSessionLaunch,
  ): Promise<void> => {
    const { scope, repository: main } = await repositoryScope(
      projectId,
      metadata,
    );
    const listed = listWorktrees(main, deps.git ? { git: deps.git } : {});
    if (!listed.ok)
      refuse(
        "The repository worktrees could not be verified. Refresh them before starting.",
      );
    const selected = listed.entries.find(
      (entry) =>
        !entry.missing &&
        sameSessionFilesystemPath(entry.path, metadata.worktree),
    );
    if (!selected)
      refuse(
        "The selected worktree is not in this repository's current Git registry.",
      );
    let canonical: string;
    try {
      if (
        !statSync(selected.path).isDirectory() ||
        !statSync(metadata.worktree).isDirectory()
      )
        refuse("The selected worktree is unavailable.");
      canonical = realpathSync.native(selected.path);
      if (
        !sameSessionFilesystemPath(
          realpathSync.native(metadata.worktree),
          canonical,
        )
      )
        refuse("The selected worktree identity changed.");
    } catch {
      refuse("The selected worktree is unavailable.");
    }
    if (launch?.extraDirectories)
      for (const path of launch.extraDirectories) {
        if (!sessionFilesystemContains(canonical, path))
          refuse("Extra directories must remain inside the checked worktree.");
        try {
          if (
            !statSync(path).isDirectory() ||
            !sessionFilesystemContains(canonical, realpathSync.native(path))
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
    const ordinary: ConversationObject[] = [];
    for (const reference of about) {
      if (reference.kind === "session") {
        const owned = createSessionRegistry(home)
          .listAll(projectId)
          .find((record) => record.id === reference.id);
        if (
          owned &&
          sameSessionFilesystemPath(owned.workspace, deps.workspace) &&
          scope.repositories.some((path) =>
            sameSessionFilesystemPath(path, owned.repository),
          )
        )
          continue;
      }
      ordinary.push(reference);
    }
    if (ordinary.length) await validateAbout(projectId, ordinary);
  };
}
