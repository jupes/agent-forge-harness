import { z } from "zod";
import {
  canonicalSmithConfigCreateRequest,
  smithConfigCreateRequestSchema,
} from "../../../scripts/config/smith-create-protocol";
import type { SmithConfigCreateRequest } from "../../../types/smith-config-create";

export const SMITH_CREATE_IDENTITIES =
  "agent-forge.smith-config-create-identities.v1";
const MAX_METADATA_BYTES = 65_536;
const identitySchema = z
  .object({
    requestId: z.uuid().refine((value) => value === value.toLowerCase()),
    scope: z.string().min(1).max(512),
    target: z.enum(["user", "workspace"]),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const savedIdentitySchema = identitySchema.extend({
  retired: z.boolean().optional(),
  retirement: z
    .enum([
      "operator-not-sent",
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
          message: "Smith create settlement evidence is incomplete.",
        });
    });
  });
export type SmithCreateIdentity = z.infer<typeof identitySchema> & {
  retired?: boolean | undefined;
  retirement?:
    | "operator-not-sent"
    | "correlated-refusal"
    | "correlated-confirmation"
    | undefined;
};

export interface SmithCreateIdentities {
  read(requestId: string): SmithCreateIdentity | null;
  list(): SmithCreateIdentity[];
  reserve(request: SmithConfigCreateRequest): Promise<{
    identity: SmithCreateIdentity;
    created: boolean;
  }>;
  retire(
    expected: SmithCreateIdentity,
    proof:
      | "operator-not-sent"
      | "correlated-refusal"
      | "correlated-confirmation",
  ): Promise<SmithCreateIdentity>;
}

export async function smithConfigCreateInputHash(
  request: SmithConfigCreateRequest,
): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalSmithConfigCreateRequest(request)),
  );
  return [...new Uint8Array(hash)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/** Stores only a bounded, read-back verified identity before the first POST. */
export function createSmithCreateIdentities(deps: {
  scope: string;
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  withLock<T>(work: () => T | Promise<T>): Promise<T>;
}): SmithCreateIdentities {
  if (deps.scope.length < 1 || deps.scope.length > 512)
    throw Error("Smith create scope is unavailable.");
  const readAll = () => {
    if (!deps.storage)
      throw Error("Smith create identity storage is unavailable.");
    const text = deps.storage.getItem(SMITH_CREATE_IDENTITIES);
    if (text === null)
      return identitiesSchema.parse({ version: 1, records: [] });
    if (new TextEncoder().encode(text).byteLength > MAX_METADATA_BYTES)
      throw Error(
        "Smith create identities exceed their storage limit. Saved identities were kept.",
      );
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw Error(
        "Smith create identities could not be verified. Saved data was kept.",
      );
    }
    const checked = identitiesSchema.safeParse(raw);
    if (
      !checked.success ||
      new Set(checked.data.records.map((item) => item.requestId)).size !==
        checked.data.records.length
    )
      throw Error(
        "Smith create identities conflict or use an unsupported version. Saved data was kept.",
      );
    return {
      version: 1,
      records: checked.data.records.map((item) => ({
        ...item,
        retired: item.retired ?? false,
      })),
    };
  };
  const save = (value: z.infer<typeof identitiesSchema>) => {
    if (!deps.storage)
      throw Error("Smith create identity storage is unavailable.");
    const text = JSON.stringify(identitiesSchema.parse(value));
    if (new TextEncoder().encode(text).byteLength > MAX_METADATA_BYTES)
      throw Error(
        "Smith create identity storage is full. Uncertain identities were kept.",
      );
    deps.storage.setItem(SMITH_CREATE_IDENTITIES, text);
    if (deps.storage.getItem(SMITH_CREATE_IDENTITIES) !== text)
      throw Error(
        "Smith create identity could not be saved and verified. No request was sent.",
      );
  };
  return {
    read(requestId) {
      const checkedId = z
        .uuid()
        .refine((value) => value === value.toLowerCase())
        .parse(requestId);
      const found = readAll().records.find(
        (item) => item.scope === deps.scope && item.requestId === checkedId,
      );
      return found ? structuredClone(found) : null;
    },
    list() {
      return structuredClone(
        readAll().records.filter((item) => item.scope === deps.scope),
      );
    },
    async reserve(value) {
      const request = smithConfigCreateRequestSchema.parse(
        structuredClone(value),
      );
      const identity = savedIdentitySchema.parse({
        requestId: request.requestId,
        scope: deps.scope,
        target: request.target,
        inputHash: await smithConfigCreateInputHash(request),
        retired: false,
      });
      return deps.withLock(() => {
        const saved = readAll(),
          existing = saved.records.find(
            (item) => item.requestId === request.requestId,
          );
        if (existing) {
          const checkedExisting = savedIdentitySchema.parse(existing);
          if (
            checkedExisting.scope !== identity.scope ||
            checkedExisting.target !== identity.target ||
            checkedExisting.inputHash !== identity.inputHash
          )
            throw Error(
              "This Smith create UUID is already held for a different original.",
            );
          return {
            identity: structuredClone({
              ...checkedExisting,
              retired: checkedExisting.retired ?? false,
            }),
            created: false,
          };
        }
        if (
          saved.records.some(
            (item) => item.scope === identity.scope && !item.retired,
          )
        )
          throw Error(
            "Another Smith create is unresolved in this workspace. Check its original receipt first.",
          );
        if (saved.records.length >= 1000)
          throw Error(
            "Smith create identity storage is full. Uncertain identities were kept.",
          );
        const next = {
          version: 1 as const,
          records: [...saved.records, identity],
        };
        save(next);
        const readBack = readAll().records.find(
          (item) => item.requestId === request.requestId,
        );
        if (
          !readBack ||
          readBack.scope !== identity.scope ||
          readBack.target !== identity.target ||
          readBack.inputHash !== identity.inputHash ||
          readBack.retired
        )
          throw Error(
            "Smith create identity could not be verified. No request was sent.",
          );
        return {
          identity: structuredClone({
            ...readBack,
            retired: readBack.retired ?? false,
          }),
          created: true,
        };
      });
    },
    async retire(expected, proof) {
      const checkedId = z
        .uuid()
        .refine((value) => value === value.toLowerCase())
        .parse(expected.requestId);
      return deps.withLock(() => {
        const saved = readAll();
        const index = saved.records.findIndex(
          (item) => item.scope === deps.scope && item.requestId === checkedId,
        );
        if (index < 0) throw Error("Smith create identity is unavailable.");
        const current = saved.records[index]!;
        if (
          current.requestId !== expected.requestId ||
          current.scope !== expected.scope ||
          current.scope !== deps.scope ||
          current.target !== expected.target ||
          current.inputHash !== expected.inputHash
        )
          throw Error(
            "Smith create identity changed before settlement could be saved.",
          );
        if (current.retired) {
          if (current.retirement !== proof)
            throw Error(
              "Smith create identity has different settlement proof.",
            );
          return structuredClone({
            ...current,
            retired: true,
            retirement: current.retirement,
          });
        }
        const next = {
          version: 1 as const,
          records: saved.records.map((item, itemIndex) =>
            itemIndex === index
              ? { ...item, retired: true, retirement: proof }
              : item,
          ),
        };
        save(next);
        const readBack = readAll().records.find(
          (item) => item.scope === deps.scope && item.requestId === checkedId,
        );
        if (
          !readBack?.retired ||
          readBack.retirement !== proof ||
          readBack.requestId !== expected.requestId ||
          readBack.scope !== expected.scope ||
          readBack.target !== expected.target ||
          readBack.inputHash !== expected.inputHash
        )
          throw Error("Smith create settlement could not be verified.");
        return structuredClone({
          ...readBack,
          retired: true,
          retirement: proof,
        });
      });
    },
  };
}
