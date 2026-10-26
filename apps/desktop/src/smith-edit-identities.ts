import { z } from "zod";
import {
  canonicalSmithConfigEditRequest,
  smithConfigEditRequestSchema,
} from "../../../scripts/config/smith-edit-protocol";
import type { SmithConfigEditRequest } from "../../../types/smith-config-edit";

export const SMITH_EDIT_IDENTITIES =
  "agent-forge.smith-config-edit-identities.v1";
const MAX_METADATA_BYTES = 65_536;
const requestId = z.uuid().refine((value) => value === value.toLowerCase());
const identitySchema = z
  .object({
    requestId,
    scope: z.string().min(1).max(512),
    target: z.enum(["user", "workspace"]),
    name: z.string().min(1).max(256),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const savedIdentitySchema = identitySchema.extend({
  retired: z.boolean().optional(),
  retirement: z
    .enum([
      "verified-not-sent",
      "correlated-refusal",
      "correlated-confirmation",
    ])
    .optional(),
});
const identitiesSchema = z
  .object({
    version: z.literal(1),
    records: z.array(savedIdentitySchema).max(1000),
  })
  .strict()
  .superRefine((value, context) => {
    value.records.forEach((record, index) => {
      if ((record.retired ?? false) !== (record.retirement !== undefined))
        context.addIssue({
          code: "custom",
          path: ["records", index],
          message: "Smith edit settlement evidence is incomplete.",
        });
    });
  });

export type SmithEditIdentity = z.infer<typeof identitySchema> & {
  retired?: boolean | undefined;
  retirement?:
    | "verified-not-sent"
    | "correlated-refusal"
    | "correlated-confirmation"
    | undefined;
};
export type SmithEditRetirement = NonNullable<SmithEditIdentity["retirement"]>;

export interface SmithEditIdentities {
  read(requestId: string): SmithEditIdentity | null;
  list(): SmithEditIdentity[];
  reserve(request: SmithConfigEditRequest): Promise<{
    identity: SmithEditIdentity;
    created: boolean;
  }>;
  retire(
    expected: SmithEditIdentity,
    proof: SmithEditRetirement,
  ): Promise<SmithEditIdentity>;
}

export async function smithConfigEditInputHash(
  request: SmithConfigEditRequest,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    canonicalSmithConfigEditRequest(request),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/** Stores only bounded identity metadata before the edit POST. */
export function createSmithEditIdentities(deps: {
  scope: string;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  withLock<T>(work: () => T | Promise<T>): Promise<T>;
}): SmithEditIdentities {
  if (deps.scope.length < 1 || deps.scope.length > 512)
    throw Error("Smith edit scope is unavailable.");

  const readAll = () => {
    if (!deps.storage)
      throw Error("Smith edit identity storage is unavailable.");
    const text = deps.storage.getItem(SMITH_EDIT_IDENTITIES);
    if (text === null)
      return identitiesSchema.parse({ version: 1, records: [] });
    if (new TextEncoder().encode(text).byteLength > MAX_METADATA_BYTES)
      throw Error(
        "Smith edit identities exceed their storage limit. Saved identities were kept.",
      );
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw Error(
        "Smith edit identities could not be verified. Saved data was kept.",
      );
    }
    const checked = identitiesSchema.safeParse(raw);
    if (
      !checked.success ||
      new Set(checked.data.records.map((record) => record.requestId)).size !==
        checked.data.records.length
    )
      throw Error(
        "Smith edit identities conflict or use an unsupported version. Saved data was kept.",
      );
    return {
      version: 1 as const,
      records: checked.data.records.map((record) => ({
        ...record,
        retired: record.retired ?? false,
      })),
    };
  };
  const save = (value: z.infer<typeof identitiesSchema>) => {
    if (!deps.storage)
      throw Error("Smith edit identity storage is unavailable.");
    const text = JSON.stringify(identitiesSchema.parse(value));
    if (new TextEncoder().encode(text).byteLength > MAX_METADATA_BYTES)
      throw Error(
        "Smith edit identity storage is full. Uncertain identities were kept.",
      );
    deps.storage.setItem(SMITH_EDIT_IDENTITIES, text);
    if (deps.storage.getItem(SMITH_EDIT_IDENTITIES) !== text)
      throw Error(
        "Smith edit identity could not be saved and verified. No request was sent.",
      );
  };

  return {
    read(id) {
      const checkedId = requestId.parse(id);
      const found = readAll().records.find(
        (record) =>
          record.scope === deps.scope && record.requestId === checkedId,
      );
      return found ? structuredClone(found) : null;
    },
    list() {
      return structuredClone(
        readAll().records.filter((record) => record.scope === deps.scope),
      );
    },
    async reserve(value) {
      const request = smithConfigEditRequestSchema.parse(
        structuredClone(value),
      );
      const identity = savedIdentitySchema.parse({
        requestId: request.requestId,
        scope: deps.scope,
        target: request.target,
        name: request.name,
        inputHash: await smithConfigEditInputHash(request),
        retired: false,
      });
      return deps.withLock(() => {
        const saved = readAll();
        const existing = saved.records.find(
          (record) => record.requestId === request.requestId,
        );
        if (existing) {
          const checked = savedIdentitySchema.parse(existing);
          if (
            checked.scope !== identity.scope ||
            checked.target !== identity.target ||
            checked.name !== identity.name ||
            checked.inputHash !== identity.inputHash
          )
            throw Error(
              "This Smith edit UUID is already held for a different original.",
            );
          return {
            identity: structuredClone({
              ...checked,
              retired: checked.retired ?? false,
            }),
            created: false,
          };
        }
        if (
          saved.records.some(
            (record) => record.scope === identity.scope && !record.retired,
          )
        )
          throw Error(
            "Another Smith edit is unresolved in this workspace. Check its original receipt first.",
          );
        if (saved.records.length >= 1000)
          throw Error(
            "Smith edit identity storage is full. Uncertain identities were kept.",
          );
        save({ version: 1, records: [...saved.records, identity] });
        const readBack = readAll().records.find(
          (record) => record.requestId === request.requestId,
        );
        if (
          !readBack ||
          readBack.scope !== identity.scope ||
          readBack.target !== identity.target ||
          readBack.name !== identity.name ||
          readBack.inputHash !== identity.inputHash ||
          readBack.retired
        )
          throw Error(
            "Smith edit identity could not be verified. No request was sent.",
          );
        return {
          identity: structuredClone({ ...readBack, retired: false }),
          created: true,
        };
      });
    },
    async retire(expected, proof) {
      const checkedId = requestId.parse(expected.requestId);
      return deps.withLock(() => {
        const saved = readAll();
        const index = saved.records.findIndex(
          (record) =>
            record.scope === deps.scope && record.requestId === checkedId,
        );
        if (index < 0) throw Error("Smith edit identity is unavailable.");
        const current = saved.records[index]!;
        if (
          current.requestId !== expected.requestId ||
          current.scope !== expected.scope ||
          current.scope !== deps.scope ||
          current.target !== expected.target ||
          current.name !== expected.name ||
          current.inputHash !== expected.inputHash
        )
          throw Error(
            "Smith edit identity changed before settlement could be saved.",
          );
        if (current.retired) {
          if (current.retirement !== proof)
            throw Error("Smith edit identity has different settlement proof.");
          return structuredClone({ ...current, retired: true });
        }
        save({
          version: 1,
          records: saved.records.map((record, recordIndex) =>
            recordIndex === index
              ? { ...record, retired: true, retirement: proof }
              : record,
          ),
        });
        const readBack = readAll().records.find(
          (record) =>
            record.scope === deps.scope && record.requestId === checkedId,
        );
        if (
          !readBack?.retired ||
          readBack.retirement !== proof ||
          readBack.requestId !== expected.requestId ||
          readBack.scope !== expected.scope ||
          readBack.target !== expected.target ||
          readBack.name !== expected.name ||
          readBack.inputHash !== expected.inputHash
        )
          throw Error("Smith edit settlement could not be verified.");
        return structuredClone({
          ...readBack,
          retired: true,
          retirement: proof,
        });
      });
    },
  };
}
