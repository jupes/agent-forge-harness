import type { ClaudeSessionLaunch } from "../../types/session-launch";
import { ConversationError } from "../conversations/error";
import type { SessionRuntime } from "./admission";
import { sessionTurnSnapshotSchema } from "./turn-protocol";

export function canonicalSessionInput(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalSessionInput).join(",")}]`;
  if (value && typeof value === "object") {
    const fields = new Map(
      Object.entries(value).filter(([, item]) => item !== undefined),
    );
    return `{${[...fields.keys()]
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalSessionInput(fields.get(key))}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Keep the reviewed input independent of a runtime callback's mutable objects. */
export async function prepareReviewedSession(
  runtime: Pick<SessionRuntime, "prepare">,
  input: { smith: string; cwd: string; launch: ClaudeSessionLaunch },
) {
  const reviewed = structuredClone(input);
  let raw: unknown;
  try {
    raw = await runtime.prepare(structuredClone(reviewed));
  } catch (error) {
    if (error instanceof ConversationError) throw error;
    throw new ConversationError(
      503,
      "The selected Claude launch is unavailable or unsupported. No provider turn was started.",
    );
  }
  const snapshot = sessionTurnSnapshotSchema.safeParse(raw);
  if (!snapshot.success)
    throw new ConversationError(
      503,
      "The prepared Claude launch is invalid or unsupported. No turn was accepted.",
    );
  if (
    snapshot.data.smith !== reviewed.smith ||
    snapshot.data.cwd !== reviewed.cwd ||
    canonicalSessionInput(snapshot.data.launch) !==
      canonicalSessionInput(reviewed.launch)
  )
    throw new ConversationError(
      503,
      "The prepared launch changed the reviewed session options. No turn was accepted.",
    );
  return structuredClone(snapshot.data);
}
