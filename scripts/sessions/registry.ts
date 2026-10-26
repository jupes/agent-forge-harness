import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { CodexChatForkOriginal } from "../../types/codex-chat-fork";
import type {
  CodexChatOwnedMetadata,
  CodexChatOwnedRecord,
} from "../../types/codex-owned-chat";
import type {
  CodexOwnedSessionMetadata,
  CodexOwnedSessionRecord,
  OwnedCodingSessionMetadata,
  OwnedCodingSessionRecord,
} from "../../types/codex-owned-task";
import type {
  GeminiChatOwnedMetadata,
  GeminiChatOwnedRecord,
} from "../../types/gemini-owned-chat";
import type {
  GeminiOwnedSessionMetadata,
  GeminiOwnedSessionRecord,
} from "../../types/gemini-owned-task";
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
import { workspaceKey } from "../projects/scope";
import { withQueueLock } from "../scheduler/queue-lock";
import { codexChatForkCaptureHash } from "./codex-chat-fork-protocol";
import {
  codexChatOwnedMetadataSchema,
  codexChatOwnedSessionSchema,
  codexOwnedMetadataSchema,
  codexOwnedSessionSchema,
} from "./codex-owned-metadata";
import {
  geminiChatOwnedMetadataSchema,
  geminiChatOwnedSessionSchema,
  geminiOwnedMetadataSchema,
  geminiOwnedSessionSchema,
} from "./gemini-owned-metadata";
import {
  ownedSessionIdSchema,
  ownedSessionMetadataSchema,
  ownedSessionSchema,
  sessionProjectIdSchema,
  sessionRequestHashSchema,
  sessionRequestIdSchema,
} from "./protocol";

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

const canonicalPaths = (value: OwnedCodingSessionMetadata) =>
  [value.workspace, value.repository, value.worktree].every(
    (path) =>
      isAbsolute(path) &&
      comparableCheckout(resolve(path)) === comparableCheckout(path),
  );
const metadataSchema = z
  .union([
    ownedSessionMetadataSchema,
    codexOwnedMetadataSchema,
    codexChatOwnedMetadataSchema,
    geminiOwnedMetadataSchema,
    geminiChatOwnedMetadataSchema,
  ])
  .refine(canonicalPaths);
const recordSchema = z
  .union([
    ownedSessionSchema,
    codexOwnedSessionSchema,
    codexChatOwnedSessionSchema,
    geminiOwnedSessionSchema,
    geminiChatOwnedSessionSchema,
  ])
  .refine(canonicalPaths);
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
interface SessionRegistry<Metadata, Record> {
  /** Full-union UUID lookup; unlike list/read, never filters by this instance's provider. */
  lookupRequestId(requestId: string): OwnedCodingSessionRecord | null;
  listWorkspace(workspace: string): OwnedCodingSessionRecord[];
  list(projectId: string): Record[];
  listAll(projectId: string): OwnedCodingSessionRecord[];
  lookup(projectId: string, sessionId: string): OwnedCodingSessionRecord;
  read(projectId: string, sessionId: string): Record;
  reserve(
    projectId: string,
    requestId: string,
    requestHash: string,
    prepare: () => Metadata | Promise<Metadata>,
  ): Promise<Record>;
}
interface CodexChatSessionRegistry
  extends SessionRegistry<CodexChatOwnedMetadata, CodexChatOwnedRecord> {
  /** Atomically adopts only the exact preallocated child identity of a captured Fork. */
  adoptForkChild(
    child: CodexChatOwnedRecord,
    parent: CodexChatOwnedRecord,
    original: CodexChatForkOriginal,
    bootstrap: () => Promise<void>,
  ): Promise<CodexChatOwnedRecord>;
}
export function createSessionRegistry(
  home: string,
): SessionRegistry<OwnedSessionMetadata, OwnedSessionRecord>;
export function createSessionRegistry(
  home: string,
  provider: "codex",
): SessionRegistry<CodexOwnedSessionMetadata, CodexOwnedSessionRecord>;
export function createSessionRegistry(
  home: string,
  provider: "codex",
  mode: "chat",
): CodexChatSessionRegistry;
export function createSessionRegistry(
  home: string,
  provider: "gemini",
): SessionRegistry<GeminiOwnedSessionMetadata, GeminiOwnedSessionRecord>;
export function createSessionRegistry(
  home: string,
  provider: "gemini",
  mode: "chat",
): SessionRegistry<GeminiChatOwnedMetadata, GeminiChatOwnedRecord>;
export function createSessionRegistry(
  home: string,
  provider: "claude" | "codex" | "gemini" = "claude",
  mode: "task" | "chat" = "task",
) {
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
    if (!sessionProjectIdSchema.safeParse(projectId).success)
      throw new SessionRegistryError(400, "Expected a project id.");
  };
  const lookup = (
    projectId: string,
    sessionId: string,
  ): OwnedCodingSessionRecord => {
    project(projectId);
    if (!ownedSessionIdSchema.safeParse(sessionId).success)
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
  };
  const registry = {
    lookup,
    lookupRequestId(requestId: string) {
      if (!sessionRequestIdSchema.safeParse(requestId).success)
        throw new SessionRegistryError(400, "Expected a Start request UUID.");
      return (
        readState().records.find((record) => record.requestId === requestId) ??
        null
      );
    },
    listWorkspace(workspace: string) {
      const key = comparableCheckout(resolve(workspace));
      return readState().records.filter(
        (record) => comparableCheckout(record.workspace) === key,
      );
    },
    listAll(projectId: string) {
      project(projectId);
      return readState().records.filter(
        (record) => record.projectId === projectId,
      );
    },
    list(projectId: string) {
      project(projectId);
      return readState().records.filter(
        (record) =>
          record.projectId === projectId &&
          record.provider === provider &&
          (provider === "claude" || record.mode === mode),
      );
    },
    read(projectId: string, sessionId: string) {
      const record = lookup(projectId, sessionId);
      if (
        record.provider !== provider ||
        (provider !== "claude" && record.mode !== mode)
      )
        throw new SessionRegistryError(
          409,
          "This session belongs to a different provider. No provider was selected implicitly.",
        );
      return record;
    },
    async reserve(
      projectId: string,
      requestId: string,
      requestHash: string,
      prepare: () =>
        | OwnedCodingSessionMetadata
        | Promise<OwnedCodingSessionMetadata>,
    ): Promise<OwnedCodingSessionRecord> {
      project(projectId);
      if (
        !sessionRequestIdSchema.safeParse(requestId).success ||
        !sessionRequestHashSchema.safeParse(requestHash).success
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
            existing.requestHash !== requestHash ||
            existing.provider !== provider ||
            (provider !== "claude" && existing.mode !== mode)
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
        if (
          !parsed.success ||
          parsed.data.provider !== provider ||
          (provider !== "claude" && parsed.data.mode !== mode) ||
          (parsed.data.origin && parsed.data.origin.projectId !== projectId)
        )
          throw new SessionRegistryError(
            400,
            "Expected bounded trusted session metadata.",
          );
        const record: OwnedCodingSessionRecord = {
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
  if (provider === "codex" && mode === "chat") {
    return Object.assign(registry, {
      async adoptForkChild(
        child: CodexChatOwnedRecord,
        parent: CodexChatOwnedRecord,
        original: CodexChatForkOriginal,
        bootstrap: () => Promise<void>,
      ): Promise<CodexChatOwnedRecord> {
        const parsed = codexChatOwnedSessionSchema.safeParse(child),
          capture =
            original.state === "captured" || original.state === "linked"
              ? original.capture
              : null;
        if (
          !parsed.success ||
          !capture ||
          parent.provider !== "codex" ||
          parent.mode !== "chat" ||
          parent.origin !== undefined ||
          parent.projectId !== original.projectId ||
          parent.id !== original.parentSessionId ||
          workspaceKey(parent.workspace) !== original.workspaceKey ||
          child.provider !== "codex" ||
          child.mode !== "chat" ||
          child.projectId !== original.projectId ||
          child.id !== original.childAppSessionId ||
          child.requestId !== original.requestId ||
          child.requestHash !== original.requestHash ||
          child.workspace !== parent.workspace ||
          child.repository !== parent.repository ||
          child.worktree !== parent.worktree ||
          child.beadId !== parent.beadId ||
          child.smith !== parent.smith ||
          child.requestedModel !== parent.requestedModel ||
          child.requestedEffort !== parent.requestedEffort ||
          child.createdAt !== original.createdAt ||
          child.origin?.kind !== "codex-chat-fork" ||
          child.origin.projectId !== original.projectId ||
          child.origin.parentSessionId !== original.parentSessionId ||
          child.origin.throughTurnRequestId !== original.throughTurnRequestId ||
          child.origin.protocolVersion !== original.protocolVersion ||
          child.origin.parentNativeThreadId !== capture.parentNativeThreadId ||
          child.origin.throughNativeTurnId !== capture.throughNativeTurnId ||
          child.origin.childNativeThreadId !== capture.childNativeThreadId ||
          child.origin.captureHash !== codexChatForkCaptureHash(capture) ||
          (original.state === "linked" &&
            (original.link.childAppSessionId !== child.id ||
              original.link.childRequestId !== child.requestId ||
              original.link.childRequestHash !== child.requestHash ||
              original.link.captureHash !== child.origin.captureHash))
        )
          throw new SessionRegistryError(
            409,
            "The captured Fork does not match this exact parent and child identity.",
          );
        const { lock, file } = checkedPaths(home);
        ensurePrivateHome(home);
        const adopted = await withQueueLock(lock, async () => {
          const state = readState(),
            byId = state.records.find((record) => record.id === child.id),
            byRequest = state.records.find(
              (record) => record.requestId === child.requestId,
            );
          if (byId || byRequest) {
            if (
              byId &&
              byRequest === byId &&
              byId.provider === "codex" &&
              byId.mode === "chat" &&
              JSON.stringify(codexChatOwnedSessionSchema.parse(byId)) ===
                JSON.stringify(parsed.data)
            )
              return byId;
            throw new SessionRegistryError(
              409,
              "A different owned session already claims this Fork child identity.",
            );
          }
          if (state.records.length >= MAX_OWNED_SESSIONS)
            throw new SessionRegistryError(
              503,
              "The private session registry is full. Saved Fork identities have been kept.",
            );
          await bootstrap();
          state.records.push(child);
          const content = JSON.stringify(state);
          if (Buffer.byteLength(content) > MAX_SESSION_REGISTRY_BYTES)
            throw new SessionRegistryError(
              503,
              "The private session registry is full. Saved Fork identities have been kept.",
            );
          try {
            writeOwnerOnly(file, content);
          } catch {
            throw new SessionRegistryError(
              503,
              "The private Fork child identity could not be confirmed. Retry the original Fork.",
            );
          }
          const confirmed = readState().records.find(
            (record) => record.id === child.id,
          );
          if (
            !confirmed ||
            confirmed.provider !== "codex" ||
            confirmed.mode !== "chat" ||
            JSON.stringify(confirmed) !== JSON.stringify(child)
          )
            throw new SessionRegistryError(
              503,
              "The private Fork child identity could not be verified after writing.",
            );
          return confirmed;
        });
        if (!adopted.ok)
          throw new SessionRegistryError(
            503,
            "The session registry is busy or unavailable. Retry the original Fork.",
          );
        return adopted.value;
      },
    });
  }
  return registry;
}
