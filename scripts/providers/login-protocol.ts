import { z } from "zod";

if (typeof window !== "undefined") z.config({ jitless: true });
export const loginProviderSchema = z.enum(["claude", "codex"]);
export const loginRequestIdSchema = z.uuid();
export const providerLoginSchema = z
  .object({
    provider: loginProviderSchema,
    requestId: loginRequestIdSchema,
    phase: z.enum(["opening", "running", "closed", "unknown", "interrupted"]),
    startedAt: z.iso.datetime(),
    endedAt: z.iso.datetime().nullable(),
    exitCode: z.number().int().nonnegative().max(0xffffffff).nullable(),
    stopped: z.boolean(),
    timedOut: z.boolean(),
  })
  .strict();
export const providerLoginPageSchema = z
  .object({ records: z.array(providerLoginSchema).max(256) })
  .strict();
export type LoginProvider = z.infer<typeof loginProviderSchema>;
export type ProviderLogin = z.infer<typeof providerLoginSchema>;
