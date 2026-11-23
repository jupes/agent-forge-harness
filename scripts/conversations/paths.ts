import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { OwnedConversationAddress } from "../../types/conversation";
import { readHomeFile } from "../hearth/home-guard";
import { isProjectId } from "../projects/store";
import { ConversationError } from "./error";
import { isConversationRequestId } from "./protocol";

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

export function conversationId(
  projectId: string,
  address?: OwnedConversationAddress,
): string {
  if (!isProjectId(projectId))
    throw new ConversationError(400, "Expected a project id.");
  if (address === undefined) return `keeper-${projectId}`;
  if (
    !address ||
    address.kind !== "session" ||
    typeof address.sessionId !== "string" ||
    !address.sessionId.startsWith("session-") ||
    !isConversationRequestId(address.sessionId.slice(8))
  )
    throw new ConversationError(400, "Expected an owned session id.");
  if (address.projectId !== projectId)
    throw new ConversationError(
      400,
      "This owned session belongs to a different project.",
    );
  return address.sessionId;
}

export function conversationFile(
  home: string,
  projectId: string,
  address?: OwnedConversationAddress,
): string {
  const name = conversationId(projectId, address);
  return join(conversationDirectory(home, projectId), `${name}.json`);
}

/** Every read-modify-write of one journal must use the same lock. */
export function conversationWriteLockFile(
  home: string,
  projectId: string,
  address?: OwnedConversationAddress,
): string {
  const name = conversationId(projectId, address);
  return join(
    conversationDirectory(home, projectId),
    address === undefined ? "write.lock.db" : `${name}.write.lock.db`,
  );
}

export function conversationLeaseFile(
  home: string,
  projectId: string,
  address?: OwnedConversationAddress,
): string {
  const name =
    address === undefined ? projectId : conversationId(projectId, address);
  const folder = join(conversationDirectory(home, projectId), "leases");
  directory(folder);
  return join(folder, `${name}.db`);
}
