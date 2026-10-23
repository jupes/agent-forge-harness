import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type {
  OwnedSessionMetadata,
  OwnedSessionRecord,
} from "../../types/owned-session";
import { comparableCheckout } from "../forge/runs";
import {
  ensurePrivateHome,
  readHomeFile,
  readSessionTranscript,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { isBeadId } from "../hearth/tracker-write";
import { isProjectId } from "../projects/store";
import { withQueueLock } from "../scheduler/queue-lock";

export const MAX_OWNED_SESSIONS = 1000;
export const MAX_SESSION_REGISTRY_BYTES = 1_048_576;

export class SessionRegistryError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

const projectIdSchema = z.string().refine(isProjectId);
const requestIdSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const sessionIdSchema = z
  .string()
  .max(44)
  .refine(
    (value) =>
      value.startsWith("session-") &&
      requestIdSchema.safeParse(value.slice(8)).success,
  );
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const label = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(
      (value) => value.trim() === value && !/[\p{Cc}\p{Cs}]/u.test(value),
    );
const pathSchema = label(1024).refine(
  (value) =>
    isAbsolute(value) &&
    comparableCheckout(resolve(value)) === comparableCheckout(value),
);
const metadataSchema = z
  .object({
    mode: z.enum(["task", "chat"]),
    provider: z.literal("claude"),
    workspace: pathSchema,
    repository: pathSchema,
    worktree: pathSchema,
    beadId: z.string().max(200).refine(isBeadId).optional(),
    smith: label(80),
    requestedModel: z
      .string()
      .max(200)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/),
    requestedEffort: z
      .enum(["low", "medium", "high", "xhigh", "max"])
      .nullable(),
  })
  .strict() satisfies z.ZodType<OwnedSessionMetadata>;
const recordSchema: z.ZodType<OwnedSessionRecord> = z
  .object({
    projectId: projectIdSchema,
    id: sessionIdSchema,
    requestId: requestIdSchema,
    requestHash: hashSchema,
    createdAt: z.iso.datetime(),
    ...metadataSchema.shape,
  })
  .strict();
const registrySchema = z
  .object({
    version: z.literal(1),
    records: z.array(recordSchema).max(MAX_OWNED_SESSIONS),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.records.map((record) => record.id)).size ===
        value.records.length &&
      new Set(value.records.map((record) => record.requestId)).size ===
        value.records.length,
  );
type Registry = z.infer<typeof registrySchema>;

export function sessionRegistryFile(home: string): string {
  return join(home, "sessions", "registry.json");
}

function checkedPaths(home: string) {
  const directory = join(home, "sessions");
  const lock = join(directory, "registry.lock.db");
  for (const [path, folder] of [
    [directory, true],
    [lock, false],
  ] as const) {
    try {
      const info = lstatSync(path);
      if (
        info.isSymbolicLink() ||
        (folder ? !info.isDirectory() : !info.isFile())
      )
        throw new SessionRegistryError(
          503,
          "The session registry path is linked or invalid. Its saved data has been kept.",
        );
    } catch (error) {
      if (error instanceof SessionRegistryError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new SessionRegistryError(
          503,
          "The session registry path could not be checked.",
        );
    }
  }
  if (readHomeFile(directory).problem !== null)
    throw new SessionRegistryError(
      503,
      "The session registry directory is not private. Its saved data has been kept.",
    );
  return { file: sessionRegistryFile(home), lock };
}

/** A metadata-only index. Reservation never dispatches or replays a provider request. */
export function createSessionRegistry(home: string) {
  const readState = (): Registry => {
    const { file } = checkedPaths(home);
    const found = readSessionTranscript(home, file);
    if (found.problem !== null)
      throw new SessionRegistryError(
        503,
        "The private session registry could not be read. Its saved data has been kept.",
      );
    if (found.text === null) return { version: 1, records: [] };
    let raw: unknown;
    try {
      if (Buffer.byteLength(found.text) > MAX_SESSION_REGISTRY_BYTES)
        throw new Error("Full registry");
      raw = JSON.parse(found.text);
    } catch {
      throw new SessionRegistryError(
        503,
        "The private session registry is invalid or full. Its saved data has been kept.",
      );
    }
    const parsed = registrySchema.safeParse(raw);
    if (!parsed.success)
      throw new SessionRegistryError(
        503,
        "The private session registry is invalid or uses an unsupported version. Its saved data has been kept.",
      );
    return parsed.data;
  };
  const project = (projectId: string) => {
    if (!projectIdSchema.safeParse(projectId).success)
      throw new SessionRegistryError(400, "Expected a project id.");
  };
  return {
    list(projectId: string): OwnedSessionRecord[] {
      project(projectId);
      return readState().records.filter(
        (record) => record.projectId === projectId,
      );
    },
    read(projectId: string, sessionId: string): OwnedSessionRecord {
      project(projectId);
      if (!sessionIdSchema.safeParse(sessionId).success)
        throw new SessionRegistryError(400, "Expected an owned session id.");
      const record = readState().records.find((item) => item.id === sessionId);
      if (!record)
        throw new SessionRegistryError(
          404,
          "This owned session is not in the registry.",
        );
      if (record.projectId !== projectId)
        throw new SessionRegistryError(
          409,
          "This owned session belongs to a different project.",
        );
      return record;
    },
    async reserve(
      projectId: string,
      requestId: string,
      requestHash: string,
      prepare: () => OwnedSessionMetadata | Promise<OwnedSessionMetadata>,
    ): Promise<OwnedSessionRecord> {
      project(projectId);
      if (
        !requestIdSchema.safeParse(requestId).success ||
        !hashSchema.safeParse(requestHash).success
      )
        throw new SessionRegistryError(
          400,
          "Expected a Start request UUID and content hash.",
        );
      const { lock, file } = checkedPaths(home);
      ensurePrivateHome(home);
      const reserved = await withQueueLock(lock, async () => {
        const state = readState();
        const existing = state.records.find(
          (item) => item.requestId === requestId,
        );
        if (existing) {
          if (
            existing.projectId !== projectId ||
            existing.requestHash !== requestHash
          )
            throw new SessionRegistryError(
              409,
              "This Start request already names different content or a different project.",
            );
          return existing;
        }
        if (state.records.length >= MAX_OWNED_SESSIONS)
          throw new SessionRegistryError(
            503,
            "The private session registry is full. Saved Start identities have been kept.",
          );
        const parsed = metadataSchema.safeParse(await prepare());
        if (!parsed.success)
          throw new SessionRegistryError(
            400,
            "Expected bounded trusted session metadata.",
          );
        const record: OwnedSessionRecord = {
          ...parsed.data,
          projectId,
          id: `session-${randomUUID()}`,
          requestId,
          requestHash,
          createdAt: new Date().toISOString(),
        };
        state.records.push(record);
        const content = JSON.stringify(state);
        if (Buffer.byteLength(content) > MAX_SESSION_REGISTRY_BYTES)
          throw new SessionRegistryError(
            503,
            "The private session registry is full. Saved Start identities have been kept.",
          );
        try {
          writeOwnerOnly(file, content);
        } catch {
          throw new SessionRegistryError(
            503,
            "The private session registry could not confirm the reservation. Retry the original Start request.",
          );
        }
        return record;
      });
      if (!reserved.ok)
        throw new SessionRegistryError(
          503,
          "The private session registry is busy or unavailable. Retry the original Start request.",
        );
      return reserved.value;
    },
  };
}
