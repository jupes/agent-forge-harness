import { z } from "zod";
import {
  canonicalSmithRoutingEditRequest,
  smithRoutingEditRequestIdSchema,
  smithRoutingEditRequestSchema,
} from "../../../scripts/config/smith-routing-edit-protocol";
import type {
  SmithRoutingEditRequest,
  SmithRoutingEditTarget,
} from "../../../types/smith-routing-edit";

export const SMITH_ROUTING_EDIT_IDENTITIES =
  "agent-forge.smith-routing-edit-identities.v1";
const MAX_METADATA_BYTES = 65_536;
const identitySchema = z
  .object({
    requestId: smithRoutingEditRequestIdSchema,
    scope: z.string().min(1).max(512),
    target: z.enum(["user", "workspace"]),
    selector: z.string().min(1).max(256),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    retired: z.boolean(),
    retirement: z
      .enum(["verified-not-sent", "confirmed", "refused"])
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.retired !== (value.retirement !== undefined))
      context.addIssue({
        code: "custom",
        message: "Routing edit settlement evidence is incomplete.",
      });
  });
const identitiesSchema = z
  .object({ version: z.literal(1), records: z.array(identitySchema).max(1000) })
  .strict();
export type SmithRoutingEditIdentity = z.infer<typeof identitySchema>;
export type SmithRoutingEditRetirement = NonNullable<
  SmithRoutingEditIdentity["retirement"]
>;
export interface SmithRoutingEditIdentities {
  read(requestId: string): SmithRoutingEditIdentity | null;
  list(): SmithRoutingEditIdentity[];
  reserve(
    request: SmithRoutingEditRequest,
    selector: string,
    expectedHash: string,
  ): Promise<{ identity: SmithRoutingEditIdentity; created: boolean }>;
  retire(
    expected: SmithRoutingEditIdentity,
    retirement: SmithRoutingEditRetirement,
  ): Promise<SmithRoutingEditIdentity>;
}

export async function smithRoutingEditInputHash(
  request: SmithRoutingEditRequest,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalSmithRoutingEditRequest(request)),
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
function sameOriginal(
  left: SmithRoutingEditIdentity,
  right: SmithRoutingEditIdentity,
): boolean {
  return (
    left.requestId === right.requestId &&
    left.scope === right.scope &&
    left.target === right.target &&
    left.selector === right.selector &&
    left.inputHash === right.inputHash
  );
}

/** Stores bounded routing identity metadata only; routing bodies and config values never persist here. */
export function createSmithRoutingEditIdentities(deps: {
  scope: string;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  withLock<T>(work: () => T | Promise<T>): Promise<T>;
}): SmithRoutingEditIdentities {
  if (!deps.scope || deps.scope.length > 512)
    throw Error("Routing edit scope is unavailable.");
  const readAll = () => {
    if (!deps.storage)
      throw Error("Routing edit identity storage is unavailable.");
    let text: string | null;
    try {
      text = deps.storage.getItem(SMITH_ROUTING_EDIT_IDENTITIES);
    } catch {
      throw Error("Routing edit identity storage is unavailable.");
    }
    if (text === null)
      return { version: 1 as const, records: [] as SmithRoutingEditIdentity[] };
    if (new TextEncoder().encode(text).byteLength > MAX_METADATA_BYTES)
      throw Error("Routing edit identity metadata exceeds its storage limit.");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw Error("Routing edit identity metadata could not be verified.");
    }
    const checked = identitiesSchema.safeParse(raw);
    if (
      !checked.success ||
      new Set(checked.data.records.map((record) => record.requestId)).size !==
        checked.data.records.length
    )
      throw Error(
        "Routing edit identities conflict or use an unsupported version.",
      );
    return checked.data;
  };
  const save = (value: z.infer<typeof identitiesSchema>) => {
    if (!deps.storage)
      throw Error("Routing edit identity storage is unavailable.");
    const text = JSON.stringify(identitiesSchema.parse(value));
    if (new TextEncoder().encode(text).byteLength > MAX_METADATA_BYTES)
      throw Error(
        "Routing edit identity storage is full; unresolved edits were kept.",
      );
    try {
      deps.storage.setItem(SMITH_ROUTING_EDIT_IDENTITIES, text);
      if (deps.storage.getItem(SMITH_ROUTING_EDIT_IDENTITIES) !== text)
        throw Error();
    } catch {
      throw Error(
        "Routing edit identity could not be saved and verified; no request was sent.",
      );
    }
  };
  return {
    read(id) {
      const requestId = smithRoutingEditRequestIdSchema.parse(id);
      const found = readAll().records.find(
        (item) => item.requestId === requestId && item.scope === deps.scope,
      );
      return found ? structuredClone(found) : null;
    },
    list() {
      return structuredClone(
        readAll().records.filter((item) => item.scope === deps.scope),
      );
    },
    async reserve(raw, selector, expectedHash) {
      const request = smithRoutingEditRequestSchema.parse(structuredClone(raw));
      const inputHash = await smithRoutingEditInputHash(request);
      if (inputHash !== expectedHash || !selector || selector.length > 256)
        throw Error("Routing edit identity does not match its frozen request.");
      const identity = identitySchema.parse({
        requestId: request.requestId,
        scope: deps.scope,
        target: request.target as SmithRoutingEditTarget,
        selector,
        inputHash,
        retired: false,
      });
      return deps.withLock(() => {
        const all = readAll(),
          existing = all.records.find(
            (item) => item.requestId === identity.requestId,
          );
        if (existing) {
          if (!sameOriginal(existing, identity))
            throw Error(
              "This routing edit UUID is held for a different original.",
            );
          return { identity: structuredClone(existing), created: false };
        }
        if (
          all.records.some((item) => item.scope === deps.scope && !item.retired)
        )
          throw Error(
            "Another routing edit is unresolved in this workspace; check its original receipt first.",
          );
        if (all.records.length >= 1000)
          throw Error(
            "Routing edit identity storage is full; unresolved edits were kept.",
          );
        save({ version: 1, records: [...all.records, identity] });
        const readBack = readAll().records.find(
          (item) => item.requestId === identity.requestId,
        );
        if (!readBack || !sameOriginal(readBack, identity) || readBack.retired)
          throw Error(
            "Routing edit reservation readback did not match; no request was sent.",
          );
        return { identity: structuredClone(readBack), created: true };
      });
    },
    async retire(expected, retirement) {
      return deps.withLock(() => {
        const all = readAll(),
          index = all.records.findIndex(
            (item) =>
              item.requestId === expected.requestId &&
              item.scope === deps.scope,
          );
        const current = index < 0 ? null : (all.records[index] ?? null);
        if (!current || !sameOriginal(current, expected))
          throw Error(
            "Routing edit retirement does not match its saved identity.",
          );
        if (current.retired) {
          if (current.retirement !== retirement)
            throw Error("Routing edit has conflicting settlement evidence.");
          return structuredClone(current);
        }
        const updated = identitySchema.parse({
          ...current,
          retired: true,
          retirement,
        });
        const records = [...all.records];
        records[index] = updated;
        save({ version: 1, records });
        const readBack = readAll().records[index];
        if (
          !readBack ||
          !sameOriginal(readBack, expected) ||
          !readBack.retired ||
          readBack.retirement !== retirement
        )
          throw Error("Routing edit retirement readback did not match.");
        return structuredClone(readBack);
      });
    },
  };
}
