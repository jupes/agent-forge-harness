import { lstatSync } from "node:fs";
import { join } from "node:path";
import { readHomeFile } from "../hearth/home-guard";
import { isProjectId } from "../projects/store";
import { ConversationError } from "./error";

/** Reject pre-existing links before even opening the write/dispatch lock. */
function directory(path: string): void {
  try {
    const found = lstatSync(path);
    if (found.isSymbolicLink() || !found.isDirectory())
      throw new ConversationError(
        503,
        "The conversation directory is linked or is not a directory. Its data has been kept.",
      );
  } catch (error) {
    if (error instanceof ConversationError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new ConversationError(
        503,
        "The conversation directory could not be checked.",
      );
  }
  if (readHomeFile(path).problem !== null)
    throw new ConversationError(
      503,
      "The conversation directory is not private. Its data has been kept.",
    );
}

export function conversationDirectory(home: string, projectId: string): string {
  if (!isProjectId(projectId))
    throw new ConversationError(400, "Expected a project id.");
  const path = join(home, "conversations");
  directory(path);
  return path;
}

export function conversationFile(home: string, projectId: string): string {
  return join(
    conversationDirectory(home, projectId),
    `keeper-${projectId}.json`,
  );
}

export function conversationLeaseFile(home: string, projectId: string): string {
  const folder = join(conversationDirectory(home, projectId), "leases");
  directory(folder);
  return join(folder, `${projectId}.db`);
}
