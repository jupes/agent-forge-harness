import { z } from "zod";
import type { SessionStartRequest } from "../../types/session-requests";
import { ConversationError } from "../conversations/error";
import { claudeSessionLaunchSchema } from "./claude-launch";

const path = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      (value.startsWith("/") ||
        value.startsWith("\\\\") ||
        /^[a-zA-Z]:[\\/]/.test(value)) &&
      [...value].every(
        (character) =>
          character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
  );
export const sessionStartSchema = z
  .object({
    requestId: z
      .string()
      .uuid()
      .refine((id) => id === id.toLowerCase()),
    smith: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    repository: path,
    worktree: path,
    beadId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
      .optional(),
    about: z
      .array(
        z
          .object({
            kind: z.enum(["bead", "session", "run", "event"]),
            id: z.string().min(1).max(200),
          })
          .strict(),
      )
      .max(16)
      .optional(),
    launch: claudeSessionLaunchSchema
      .omit({ resumeSessionId: true, context: true })
      .strict(),
  })
  .strict();

export function parseSessionStart(input: unknown): SessionStartRequest {
  const parsed = sessionStartSchema.safeParse(input);
  if (!parsed.success)
    throw new ConversationError(
      400,
      "Expected an original Start request, smith, checked worktree and supported Claude options.",
    );
  return parsed.data;
}
