import { z } from "zod";
import type {
  GeminiChatLaunch,
  PreparedGeminiChat,
} from "../../types/gemini-chat-runtime";
import { encodeAcpClientRequest } from "./acp-wire";
import {
  geminiChatLaunchSchema,
  geminiTaskCapabilitiesSchema,
  serializeGeminiChat,
} from "./gemini-task";
import { preparedGeminiLaunchSchema } from "./gemini-task-runtime-protocol";

const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
export const preparedGeminiChatLaunchSchema = geminiChatLaunchSchema.transform(
  (value): GeminiChatLaunch => ({
    ...preparedGeminiLaunchSchema.parse({ ...value, mode: "task" }),
    mode: "chat",
  }),
);
export const preparedGeminiChatSchema: z.ZodType<PreparedGeminiChat> = z
  .object({
    version: z.literal(1),
    provider: z.literal("gemini"),
    smith: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    canonicalRoot: path,
    canonicalCwd: path,
    command: z.array(path).min(1).max(16),
    paths: z.array(path).max(35),
    launch: preparedGeminiChatLaunchSchema,
    capabilities: geminiTaskCapabilitiesSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    try {
      const serialized = serializeGeminiChat(value.launch, value.capabilities);
      if (
        serialized.stdin.length > 524_288 ||
        new TextEncoder().encode(JSON.stringify(value)).byteLength > 3_145_728
      )
        throw Error("Private input bound");
      encodeAcpClientRequest({
        id: 3,
        method: "session/prompt",
        params: {
          sessionId: "11111111-1111-4111-8111-111111111111",
          prompt: [{ type: "text", text: serialized.stdin }],
        },
      });
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "The private Gemini Chat selection is unsupported or exceeds its native bound.",
      });
    }
  });
