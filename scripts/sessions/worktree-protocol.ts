import { z } from "zod";
import type {
  SessionWorktreeReceipt,
  SessionWorktreeRequest,
} from "../../types/session-worktrees";

if (typeof window !== "undefined") z.config({ jitless: true });

const label = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) => value.trim() === value && !/[\p{Cc}\p{Cs}]/u.test(value),
    );
const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const path = label(1024).refine(
  (value) =>
    (value.startsWith("/") ||
      value.startsWith("\\\\") ||
      /^[a-zA-Z]:[\\/]/.test(value)) &&
    !value.split(/[\\/]/).some((part) => part === "." || part === ".."),
);
const branch = label(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/)
  .refine(
    (value) =>
      value !== "HEAD" &&
      !value.startsWith("refs/") &&
      !value.includes("..") &&
      value
        .split("/")
        .every(
          (part) =>
            part &&
            !part.startsWith(".") &&
            !part.endsWith(".") &&
            !part.endsWith(".lock"),
        ),
  );
export const sessionWorktreeRequestSchema = z
  .object({
    requestId: uuid,
    repository: path,
    baseRef: label(200).refine(
      (value) => !value.startsWith("-") && !/\s/.test(value),
    ),
    branch,
    beadId: label(200)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
      .optional(),
  })
  .strict() satisfies z.ZodType<SessionWorktreeRequest>;

export const sessionWorktreeReceiptSchema = z
  .object({
    projectId: z
      .string()
      .refine(
        (value) =>
          value.startsWith("project-") &&
          uuid.safeParse(value.slice(8)).success,
      ),
    requestId: uuid,
    repository: path,
    baseRef: label(200),
    resolvedCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    branch,
    worktree: z
      .object({
        id: z.string().regex(/^sw-[a-f0-9]{28}$/),
        path,
        branch,
        createdAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    state: z.enum(["created", "unknown", "refused"]),
    reason: label(1000).nullable(),
  })
  .strict()
  .refine(
    (value) =>
      (value.state !== "created" ||
        (value.worktree !== null && value.reason === null)) &&
      (value.state === "created" || value.reason !== null) &&
      (value.worktree === null ||
        (value.worktree.branch === value.branch &&
          value.worktree.path.replaceAll("\\", "/") ===
            `${value.repository.replaceAll("\\", "/").replace(/\/+$/, "")}/trees/${value.worktree.id}`)),
  ) satisfies z.ZodType<SessionWorktreeReceipt>;
