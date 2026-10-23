import { z } from "zod";

/** Browser-safe identity shapes; these do not establish filesystem authority. */
export const sessionProjectIdSchema = z
  .string()
  .regex(
    /^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const sessionRequestIdSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
export const ownedSessionIdSchema = z
  .string()
  .max(44)
  .refine(
    (value) =>
      value.startsWith("session-") &&
      sessionRequestIdSchema.safeParse(value.slice(8)).success,
  );
export const sessionRequestHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
