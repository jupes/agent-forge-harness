import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type {
  ProjectShiftIntent,
  ProjectShiftStartRequest,
} from "../../types/project-shifts";
import { ConversationError } from "../conversations/error";
import {
  ensurePrivateHome,
  readHomeFile,
  readSessionTranscript,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { resolveCheckout } from "../ledger/workspace";
import { workspaceKey } from "../projects/scope";
import { isProjectId } from "../projects/store";
import { withQueueLock } from "../scheduler/queue-lock";
import { shiftOptions } from "../scheduler/shift";
import { runOptions } from "../scheduler/shift-cli-runtime";
import {
  projectShiftIntentSchema,
  projectShiftStartSchema,
  shiftRequestIdSchema,
} from "./protocol";
import { SHIFT_START_FIELDS } from "./start-fields";

export const MAX_PROJECT_SHIFT_REQUESTS = 1000;
export const MAX_PROJECT_SHIFT_BYTES = 2_097_152;
const shiftId = z.string().regex(/^shift-\d{8}-\d{6}-[0-9a-f]{4}$/);
export const projectShiftRegistryFile = (home: string) =>
  join(home, "project-shifts", "starts.json");

export function projectShiftRequestHash(
  projectId: string,
  workspace: string,
  request: ProjectShiftStartRequest,
): string {
  const options = request.options;
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        projectId,
        workspace: workspaceKey(workspace),
        requestId: request.requestId,
        expectedCatalogRevision: request.expectedCatalogRevision,
        options: {
          for: options.for,
          concurrency: options.concurrency,
          maxBeads: options.maxBeads,
          maxUsd: options.maxUsd,
          repairs: options.repairs,
          base: options.base,
          ...(options.epic !== undefined ? { epic: options.epic } : {}),
          ...(options.smith !== undefined ? { smith: options.smith } : {}),
          ...(options.runTimeout !== undefined
            ? { runTimeout: options.runTimeout }
            : {}),
        },
      }),
    )
    .digest("hex");
}
export function projectShiftFlags(request: ProjectShiftStartRequest): string[] {
  return Object.entries(SHIFT_START_FIELDS).flatMap(([field, flag]) => {
    const value =
      request.options[field as keyof ProjectShiftStartRequest["options"]];
    return value === undefined ? [] : [flag, String(value)];
  });
}
function parsedRequest(raw: unknown): ProjectShiftStartRequest {
  const parsed = projectShiftStartSchema.safeParse(raw);
  if (!parsed.success)
    throw new ConversationError(
      400,
      "Expected a strict reviewed shift Start request.",
    );
  const flags = runOptions(projectShiftFlags(parsed.data));
  if (!flags.ok || !shiftOptions(flags.value).ok)
    throw new ConversationError(
      400,
      "The reviewed bounds are not valid shift options.",
    );
  return parsed.data;
}
function validBounds(request: ProjectShiftStartRequest): boolean {
  const parsed = runOptions(projectShiftFlags(request));
  return parsed.ok && shiftOptions(parsed.value).ok;
}
const intentSchema: z.ZodType<ProjectShiftIntent> =
  projectShiftIntentSchema.refine(
    (value) =>
      validBounds(value.request) &&
      value.requestHash ===
        projectShiftRequestHash(
          value.projectId,
          value.workspace,
          value.request,
        ),
  );
const journalSchema = z
  .object({
    version: z.literal(1),
    records: z.array(intentSchema).max(MAX_PROJECT_SHIFT_REQUESTS),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.records.map((record) => record.request.requestId)).size ===
        value.records.length &&
      new Set(value.records.map((record) => record.shiftId)).size ===
        value.records.length,
  );
type Journal = z.infer<typeof journalSchema>;
function unavailable(reason: string): never {
  throw new ConversationError(
    503,
    `${reason} Saved Start identities have been kept.`,
  );
}
function checkedPaths(home: string) {
  const directory = join(home, "project-shifts"),
    file = projectShiftRegistryFile(home),
    lock = join(directory, "starts.lock.db");
  for (const [path, folder] of [
    [directory, true],
    [file, false],
    [lock, false],
  ] as const) {
    try {
      const info = lstatSync(path);
      if (
        info.isSymbolicLink() ||
        (folder ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
      )
        unavailable("The private shift intent path is linked or invalid.");
    } catch (error) {
      if (error instanceof ConversationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        unavailable("The private shift intent path could not be checked.");
    }
  }
  if (readHomeFile(directory).problem !== null)
    unavailable("The shift intent directory is not private.");
  return { file, lock };
}

/** Original request identity only. Nothing in this registry dispatches or replays a shift. */
export function createProjectShiftRegistry(options: {
  home: string;
  root: string;
}) {
  const workspace = resolveCheckout(options.root).workspace;
  const project = (id: string) => {
    if (!isProjectId(id))
      throw new ConversationError(400, "Expected a project id.");
  };
  const readState = (): Journal => {
    const { file } = checkedPaths(options.home);
    const found = readSessionTranscript(options.home, file);
    if (found.problem !== null)
      unavailable("The private shift intents could not be read.");
    if (found.text === null) return { version: 1, records: [] };
    let raw: unknown;
    try {
      if (Buffer.byteLength(found.text) > MAX_PROJECT_SHIFT_BYTES)
        throw Error("Full intent store");
      raw = JSON.parse(found.text);
    } catch {
      unavailable("The private shift intents are invalid or full.");
    }
    const parsed = journalSchema.safeParse(raw);
    if (!parsed.success)
      unavailable(
        "The private shift intents are invalid or use an unsupported version.",
      );
    return parsed.data;
  };
  const belongs = (intent: ProjectShiftIntent, projectId: string) => {
    if (
      intent.projectId !== projectId ||
      workspaceKey(intent.workspace) !== workspaceKey(workspace)
    )
      throw new ConversationError(
        409,
        "This original shift Start belongs to a different project or workspace.",
      );
    return intent;
  };
  const save = (state: Journal) => {
    const { file } = checkedPaths(options.home),
      text = JSON.stringify(state);
    if (
      !journalSchema.safeParse(state).success ||
      Buffer.byteLength(text) > MAX_PROJECT_SHIFT_BYTES
    )
      unavailable("The private shift intent store is full or invalid.");
    try {
      writeOwnerOnly(file, text);
    } catch {
      unavailable(
        "The shift intent write could not be confirmed. Read the original request before doing anything else.",
      );
    }
  };
  async function mark(
    projectId: string,
    requestId: string,
    requestHash: string,
    field: "attemptedAt" | "executionStartedAt",
  ): Promise<{ intent: ProjectShiftIntent; created: boolean }> {
    project(projectId);
    if (
      !shiftRequestIdSchema.safeParse(requestId).success ||
      !/^[a-f0-9]{64}$/.test(requestHash)
    )
      throw new ConversationError(
        400,
        "Expected the original Start UUID and reviewed content hash.",
      );
    const { lock } = checkedPaths(options.home);
    ensurePrivateHome(options.home);
    const marked = await withQueueLock(lock, async () => {
      const state = readState(),
        intent = state.records.find(
          (item) => item.request.requestId === requestId,
        );
      if (!intent)
        throw new ConversationError(
          404,
          "This original shift Start is not in the private registry.",
        );
      belongs(intent, projectId);
      if (intent.requestHash !== requestHash)
        throw new ConversationError(
          409,
          "The original reviewed shift bounds do not match.",
        );
      if (field === "executionStartedAt" && intent.attemptedAt === null)
        throw new ConversationError(
          409,
          "The original Start has no authorized launch attempt.",
        );
      if ((intent[field] ?? null) !== null) return { intent, created: false };
      intent[field] = new Date().toISOString();
      save(state);
      return { intent, created: true };
    });
    if (!marked.ok)
      unavailable("The private shift intent registry is busy or unavailable.");
    return marked.value;
  }
  return {
    markAttempted: (
      projectId: string,
      requestId: string,
      requestHash: string,
    ) => mark(projectId, requestId, requestHash, "attemptedAt"),
    claimExecution: (
      projectId: string,
      requestId: string,
      requestHash: string,
    ) => mark(projectId, requestId, requestHash, "executionStartedAt"),
    read(projectId: string, requestId: string): ProjectShiftIntent {
      project(projectId);
      if (!shiftRequestIdSchema.safeParse(requestId).success)
        throw new ConversationError(
          400,
          "Expected the original Start request UUID.",
        );
      const intent = readState().records.find(
        (item) => item.request.requestId === requestId,
      );
      if (!intent)
        throw new ConversationError(
          404,
          "This original shift Start is not in the private registry.",
        );
      return belongs(intent, projectId);
    },
    list(projectId: string): ProjectShiftIntent[] {
      project(projectId);
      return readState().records.filter(
        (item) =>
          item.projectId === projectId &&
          workspaceKey(item.workspace) === workspaceKey(workspace),
      );
    },
    async reserve(
      projectId: string,
      raw: ProjectShiftStartRequest,
      prepare: (
        reviewed: ProjectShiftStartRequest,
      ) => Promise<{ shiftId: string }>,
    ): Promise<{ intent: ProjectShiftIntent; created: boolean }> {
      project(projectId);
      const request = parsedRequest(raw),
        requestHash = projectShiftRequestHash(projectId, workspace, request);
      const { lock } = checkedPaths(options.home);
      ensurePrivateHome(options.home);
      const result = await withQueueLock(lock, async () => {
        const state = readState(),
          existing = state.records.find(
            (item) => item.request.requestId === request.requestId,
          );
        if (existing) {
          belongs(existing, projectId);
          if (existing.requestHash !== requestHash)
            throw new ConversationError(
              409,
              "This Start request UUID already names different reviewed bounds.",
            );
          return { intent: existing, created: false };
        }
        if (state.records.length >= MAX_PROJECT_SHIFT_REQUESTS)
          unavailable("The private shift intent store is full.");
        const trusted = await prepare(structuredClone(request));
        if (!shiftId.safeParse(trusted.shiftId).success)
          throw new ConversationError(400, "Expected a trusted shift id.");
        const intent: ProjectShiftIntent = {
          projectId,
          workspace,
          shiftId: trusted.shiftId,
          request,
          requestHash,
          createdAt: new Date().toISOString(),
          attemptedAt: null,
          executionStartedAt: null,
        };
        state.records.push(intent);
        save(state);
        return { intent, created: true };
      });
      if (!result.ok)
        unavailable(
          "The private shift intent registry is busy or unavailable.",
        );
      return result.value;
    },
  };
}
