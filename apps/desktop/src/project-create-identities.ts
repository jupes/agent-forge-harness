import { z } from "zod";
import {
  type ProjectCreateIdentity,
  type ProjectCreateOriginal,
  type ProjectCreateReserveRequest,
  projectCreateIdentitySchema,
  projectCreateReserveSchema,
} from "../../../scripts/projects/create-protocol";
import { workspaceKey } from "../../../scripts/projects/scope";

export const PROJECT_CREATE_IDENTITIES =
  "agent-forge.project-create-identities.v1";
const MAX_METADATA_BYTES = 1_048_576;
const MAX_RECORDS = 256;
const requestIdSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase());
const recordSchema = z
  .object({
    workspaceKey: z.string().min(1).max(1024),
    request: projectCreateReserveSchema,
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum([
      "pending-reserve",
      "not-sent",
      "unknown",
      "reserved",
      "created",
      "retired",
    ]),
  })
  .strict();
const metadataSchema = z
  .object({
    version: z.literal(1),
    records: z.array(recordSchema).max(MAX_RECORDS),
  })
  .strict()
  .refine(
    ({ records }) =>
      new Set(records.map((row) => row.request.requestId)).size ===
        records.length &&
      new Set(
        records.map((row) => `${row.workspaceKey}:${row.request.requestId}`),
      ).size === records.length,
  );
export type ProjectCreateLocalIdentity = z.infer<typeof recordSchema>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export function canonicalProjectCreateJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalProjectCreateJson).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalProjectCreateJson(value[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export async function projectCreateRequestHash(
  request: ProjectCreateReserveRequest,
): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalProjectCreateJson(request)),
  );
  return [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function sameRequest(
  left: ProjectCreateReserveRequest,
  right: ProjectCreateReserveRequest,
): boolean {
  return canonicalProjectCreateJson(left) === canonicalProjectCreateJson(right);
}

/** Private, bounded original metadata retained before every create POST. */
export function createProjectCreateIdentities(deps: {
  workspace: string | null;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  withLock<T>(work: () => T | Promise<T>): Promise<T>;
}) {
  const scope = deps.workspace ? workspaceKey(deps.workspace) : null;
  const requireScope = () => {
    if (!scope) throw Error("The trusted project workspace is unavailable.");
    return scope;
  };
  const readAll = () => {
    requireScope();
    if (!deps.storage)
      throw Error("Saved project create identities are unavailable.");
    const text = deps.storage.getItem(PROJECT_CREATE_IDENTITIES);
    if (text === null) return { version: 1 as const, records: [] };
    if (new TextEncoder().encode(text).byteLength > MAX_METADATA_BYTES)
      throw Error(
        "Saved project create identities exceed their limit. Existing bytes were kept.",
      );
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw Error(
        "Saved project create identities could not be verified. Existing bytes were kept.",
      );
    }
    const checked = metadataSchema.safeParse(raw);
    if (!checked.success)
      throw Error(
        "Saved project create identities conflict or use an unsupported version. Existing bytes were kept.",
      );
    return checked.data;
  };
  const save = (value: z.infer<typeof metadataSchema>) => {
    const checked = metadataSchema.safeParse(value);
    if (!checked.success || !deps.storage)
      throw Error("The original project request could not be saved.");
    const text = JSON.stringify(checked.data);
    if (new TextEncoder().encode(text).byteLength > MAX_METADATA_BYTES)
      throw Error(
        "Saved project create identities are full. Uncertain originals were kept.",
      );
    deps.storage.setItem(PROJECT_CREATE_IDENTITIES, text);
    if (deps.storage.getItem(PROJECT_CREATE_IDENTITIES) !== text)
      throw Error(
        "The project original could not be saved and verified. No request was sent.",
      );
  };
  const active = (item: ProjectCreateLocalIdentity) =>
    item.state !== "created" && item.state !== "retired";

  return {
    list(): ProjectCreateLocalIdentity[] {
      const currentScope = requireScope();
      return structuredClone(
        readAll().records.filter((item) => item.workspaceKey === currentScope),
      );
    },
    async reserve(
      originalInput: ProjectCreateOriginal,
      expectedCatalogRevision: number,
      mint: () => string,
    ): Promise<{ identity: ProjectCreateLocalIdentity; created: boolean }> {
      const currentScope = requireScope();
      const frozenOriginal = structuredClone(originalInput);
      const revision = expectedCatalogRevision;
      return deps.withLock(async () => {
        const value = readAll();
        const current = value.records.find(
          (item) => item.workspaceKey === currentScope && active(item),
        );
        if (current)
          return { identity: structuredClone(current), created: false };
        if (value.records.length >= MAX_RECORDS)
          throw Error(
            "Saved project create identities are full. Existing originals were kept.",
          );
        const request = projectCreateReserveSchema.parse({
          requestId: requestIdSchema.parse(mint()),
          expectedCatalogRevision: revision,
          original: frozenOriginal,
        });
        const requestHash = await projectCreateRequestHash(request);
        if (
          value.records.some(
            (item) => item.request.requestId === request.requestId,
          )
        )
          throw Error("The project request ID is already in use.");
        const identity = recordSchema.parse({
          workspaceKey: currentScope,
          request,
          requestHash,
          state: "pending-reserve",
        });
        save({ version: 1, records: [...value.records, identity] });
        return { identity: structuredClone(identity), created: true };
      });
    },
    async find(requestId: string): Promise<ProjectCreateLocalIdentity | null> {
      const currentScope = requireScope();
      const id = requestIdSchema.parse(requestId);
      return structuredClone(
        readAll().records.find(
          (item) =>
            item.workspaceKey === currentScope && item.request.requestId === id,
        ) ?? null,
      );
    },
    async update(
      requestId: string,
      requestHash: string,
      nextState: ProjectCreateLocalIdentity["state"],
    ): Promise<ProjectCreateLocalIdentity> {
      const currentScope = requireScope();
      return deps.withLock(() => {
        const value = readAll();
        const index = value.records.findIndex(
          (item) =>
            item.workspaceKey === currentScope &&
            item.request.requestId === requestId,
        );
        const previous = value.records[index];
        if (!previous || previous.requestHash !== requestHash)
          throw Error("The exact saved project original could not be matched.");
        if (!active(previous) && previous.state !== nextState)
          throw Error("A terminal project create identity cannot be changed.");
        const updated = recordSchema.parse({ ...previous, state: nextState });
        const records = [...value.records];
        records[index] = updated;
        save({ version: 1, records });
        return structuredClone(updated);
      });
    },
    async observe(
      identity: ProjectCreateIdentity,
    ): Promise<ProjectCreateLocalIdentity> {
      const currentScope = requireScope();
      const frozen = projectCreateIdentitySchema.parse(
        structuredClone(identity),
      );
      const request = projectCreateReserveSchema.parse({
        requestId: frozen.requestId,
        expectedCatalogRevision: frozen.baseRevision,
        original: frozen.original,
      });
      if ((await projectCreateRequestHash(request)) !== frozen.requestHash)
        throw Error("The saved project original hash does not match.");
      const nextState =
        frozen.state === "reserved"
          ? "reserved"
          : frozen.state === "created"
            ? "created"
            : "retired";
      return deps.withLock(() => {
        const value = readAll();
        const index = value.records.findIndex(
          (item) =>
            item.workspaceKey === currentScope &&
            item.request.requestId === frozen.requestId,
        );
        const existing = value.records[index];
        if (existing) {
          if (
            existing.requestHash !== frozen.requestHash ||
            !sameRequest(existing.request, request)
          )
            throw Error("A different project original is already saved.");
          if (!active(existing) && existing.state !== nextState)
            throw Error(
              "Project create readback conflicts with saved history.",
            );
          const updated = recordSchema.parse({ ...existing, state: nextState });
          const records = [...value.records];
          records[index] = updated;
          save({ version: 1, records });
          return structuredClone(updated);
        }
        if (value.records.length >= MAX_RECORDS)
          throw Error("Saved project create identities are full.");
        const created = recordSchema.parse({
          workspaceKey: currentScope,
          request,
          requestHash: frozen.requestHash,
          state: nextState,
        });
        save({ version: 1, records: [...value.records, created] });
        return structuredClone(created);
      });
    },
  };
}
