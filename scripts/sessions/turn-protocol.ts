import { z } from "zod";
import {
  claudeLaunchCapabilitiesSchema,
  claudeSessionLaunchSchema,
  serializeClaudeLaunch,
} from "./claude-launch";

/** Storage codec only; no public message route accepts a prepared snapshot. */
export const sessionTurnSnapshotSchema = z
  .object({
    version: z.literal(1),
    provider: z.literal("claude"),
    smith: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    cwd: z
      .string()
      .min(1)
      .max(1024)
      .refine(
        (path) =>
          (path.startsWith("/") ||
            path.startsWith("\\\\") ||
            /^[a-zA-Z]:[\\/]/.test(path)) &&
          [...path].every(
            (character) =>
              character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
          ),
      ),
    launch: claudeSessionLaunchSchema,
    capabilities: claudeLaunchCapabilitiesSchema,
  })
  .strict()
  .superRefine((value, context) => {
    try {
      serializeClaudeLaunch(value.launch, value.capabilities);
      // The journal's 8 MiB ceiling also includes previous turns and output.
      if (
        new TextEncoder().encode(JSON.stringify(value)).byteLength > 2_097_152
      )
        context.addIssue({
          code: "custom",
          message: "The prepared session input exceeds 2 MiB.",
        });
    } catch {
      context.addIssue({
        code: "custom",
        message: "The prepared Claude launch cannot be verified.",
      });
    }
  });
