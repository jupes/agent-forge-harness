import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ProjectRecord } from "../../types/projects";
import { ProjectStoreError } from "./store";

/** Lexical comparison only AFTER native canonical consent; no filesystem access. */
export function physicalSourceText(root: string): string {
  if (!isAbsolute(root) || /[\p{Cc}\p{Cs}]/u.test(root))
    throw new ProjectStoreError(
      503,
      "The workspace source root is unsupported.",
    );
  if (process.platform !== "win32") return root.replace(/\/+$/, "");
  let value = root.replaceAll("\\", "/");
  if (/^\/\/\?\/UNC\//i.test(value)) value = "//" + value.slice(8);
  else if (/^\/\/\?\/[a-z]:\//i.test(value)) value = value.slice(4);
  return value.replace(/\/+$/, "").toLowerCase();
}
export function projectWorkspaceRef(projectId: string, root: string): string {
  return createHash("sha256")
    .update(JSON.stringify([projectId, root]))
    .digest("hex");
}
export function sourceWorkspace(project: ProjectRecord, ref: string) {
  const scope = project.workspaces.find(
    (scope) => projectWorkspaceRef(project.id, scope.root) === ref,
  );
  if (!scope)
    throw new ProjectStoreError(
      404,
      "This registered workspace was not found.",
    );
  return scope;
}
export function sourceBinding(project: ProjectRecord, ref: string): string {
  const scope = sourceWorkspace(project, ref);
  return JSON.stringify({
    projectId: project.id,
    slug: project.slug,
    archived: project.archived,
    root: scope.root,
    repositories: scope.repositories,
  });
}

/** Capture approved/own root identity without scanning it; replacement is a hold. */
export function pinSourceRoot(root: string): () => boolean {
  const read = () => {
    const stat = lstatSync(root, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev < 0n ||
      stat.ino <= 0n
    )
      throw new ProjectStoreError(
        503,
        "The workspace source directory could not be verified.",
      );
    return String(stat.dev) + ":" + String(stat.ino);
  };
  const original = read();
  return () => {
    try {
      return read() === original;
    } catch {
      return false;
    }
  };
}
