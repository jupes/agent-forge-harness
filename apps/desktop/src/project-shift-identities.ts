import { z } from "zod";
import { workspaceKey } from "../../../scripts/projects/scope";
import {
  sessionProjectIdSchema,
  sessionRequestHashSchema,
} from "../../../scripts/sessions/identity-protocol";
import {
  projectShiftStartSchema,
  shiftRequestIdSchema,
} from "../../../scripts/shifts/protocol";
import { canonicalProjectShiftStart } from "../../../scripts/shifts/start-input";
import type { ProjectShiftStartRequest } from "../../../types/project-shifts";

export const PROJECT_SHIFT_IDENTITIES =
  "agent-forge.project-shift-identities.v1";
export interface ProjectShiftScope {
  projectId: string;
  workspace: string;
}
const identitySchema = z
  .object({
    projectId: sessionProjectIdSchema,
    scope: sessionRequestHashSchema,
    requestId: shiftRequestIdSchema,
    requestHash: sessionRequestHashSchema,
  })
  .strict();
export type ProjectShiftIdentity = z.infer<typeof identitySchema>;
const schema = z
  .object({ version: z.literal(1), records: z.array(identitySchema).max(256) })
  .strict()
  .refine(
    (value) =>
      new Set(value.records.map((row) => `${row.projectId}:${row.scope}`))
        .size === value.records.length &&
      new Set(value.records.map((row) => row.requestId)).size ===
        value.records.length,
  );
async function hash(text: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(bytes)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}
export const projectShiftInputHash = (
  scope: ProjectShiftScope,
  request: ProjectShiftStartRequest,
) =>
  hash(canonicalProjectShiftStart(scope.projectId, scope.workspace, request));
const scopeHash = (scope: ProjectShiftScope) =>
  hash(workspaceKey(scope.workspace));

/** Metadata only, before POST. Uncertain original identities are never evicted or automatically resent. */
export function createProjectShiftIdentities(deps: {
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  withLock<T>(work: () => T | Promise<T>): Promise<T>;
}) {
  const stored = () => {
    if (!deps.storage)
      throw Error("Original shift identity storage is unavailable.");
    const text = deps.storage.getItem(PROJECT_SHIFT_IDENTITIES);
    if (text === null) return { version: 1 as const, records: [] };
    let raw: unknown;
    try {
      if (new TextEncoder().encode(text).byteLength > 100_000)
        throw Error("Overfull metadata");
      raw = JSON.parse(text);
    } catch {
      throw Error(
        "Saved shift identities could not be verified. Their bytes have been kept.",
      );
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      throw Error(
        "Saved shift identities conflict or use an unsupported version. Their bytes have been kept.",
      );
    return parsed.data;
  };
  const save = (value: z.infer<typeof schema>) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success || !deps.storage)
      throw Error("The original shift identity could not be saved.");
    const text = JSON.stringify(parsed.data);
    if (new TextEncoder().encode(text).byteLength > 100_000)
      throw Error(
        "Original shift identity storage is full; existing identities were kept.",
      );
    deps.storage.setItem(PROJECT_SHIFT_IDENTITIES, text);
    if (deps.storage.getItem(PROJECT_SHIFT_IDENTITIES) !== text)
      throw Error(
        "The original shift identity could not be saved and verified.",
      );
  };
  return {
    async read(scope: ProjectShiftScope): Promise<ProjectShiftIdentity | null> {
      const key = await scopeHash(scope);
      return structuredClone(
        stored().records.find(
          (row) => row.projectId === scope.projectId && row.scope === key,
        ) ?? null,
      );
    },
    async reserve(
      scope: ProjectShiftScope,
      input: Omit<ProjectShiftStartRequest, "requestId">,
      mint: () => string,
    ) {
      const draft = structuredClone(input),
        key = await scopeHash(scope);
      return deps.withLock(async () => {
        const value = stored(),
          held = value.records.find(
            (row) => row.projectId === scope.projectId && row.scope === key,
          );
        if (held)
          return {
            identity: structuredClone(held),
            created: false,
            request: null,
          };
        if (value.records.length >= 256)
          throw Error(
            "Original shift identity storage is full. Uncertain Starts were kept.",
          );
        const parsed = projectShiftStartSchema.safeParse({
          ...draft,
          requestId: mint(),
        });
        if (!parsed.success)
          throw Error("Review valid shift bounds before starting.");
        const identity = identitySchema.safeParse({
          projectId: scope.projectId,
          scope: key,
          requestId: parsed.data.requestId,
          requestHash: await projectShiftInputHash(scope, parsed.data),
        });
        if (
          !identity.success ||
          value.records.some(
            (row) => row.requestId === identity.data?.requestId,
          )
        )
          throw Error("The original shift identity could not be verified.");
        save({ version: 1, records: [...value.records, identity.data] });
        return {
          identity: identity.data,
          created: true,
          request: structuredClone(parsed.data),
        };
      });
    },
    release(identity: ProjectShiftIdentity) {
      return deps.withLock(() => {
        const value = stored(),
          held = value.records.find(
            (row) =>
              row.projectId === identity.projectId &&
              row.scope === identity.scope,
          );
        if (!held) return;
        if (
          held.requestId !== identity.requestId ||
          held.requestHash !== identity.requestHash
        )
          throw Error("A different original shift identity is still held.");
        save({
          version: 1,
          records: value.records.filter((row) => row !== held),
        });
      });
    },
  };
}
export type ProjectShiftIdentities = ReturnType<
  typeof createProjectShiftIdentities
>;
