import { parse, stringify } from "yaml";
import { z } from "zod";

export const KNOWLEDGE_LIMITS = Object.freeze({
  documentBytes: 96 * 1024,
  lines: 400,
  sourceFiles: 32,
  fileBytes: 16 * 1024,
  sourceBytes: 192 * 1024,
  entries: 4096,
  depth: 2,
  operations: 256,
});
const text = z.string().min(1).max(8000),
  strings = z.array(text).max(32);
const path = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.includes("\\") &&
      !value.startsWith("/") &&
      !/^[a-z]:/i.test(value) &&
      !/[\p{Cc}\p{Cs}]/u.test(value) &&
      value
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
  );
export const generatedKnowledgeSchema = z
  .object({
    overview: z
      .object({
        name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/),
        description: text,
        purpose: text,
        tech_stack: z
          .object({
            runtime: text,
            framework: text,
            language: text,
            key_libraries: strings,
          })
          .strict(),
      })
      .strict(),
    architecture: z
      .object({
        structure: text,
        entry_points: strings,
        key_components: strings,
      })
      .strict(),
    patterns: z
      .object({
        error_handling: text,
        state_management: text,
        module_organization: text,
        authentication: text,
        testing: text,
      })
      .strict(),
    conventions: z
      .object({
        commit_format: text,
        branch_naming: text,
        pr_requirements: strings,
        coding_standards: strings,
      })
      .strict(),
    integration_points: z
      .object({
        apis: z
          .array(
            z
              .object({
                endpoint: text,
                method: text,
                request: text,
                response: text,
                notes: text,
              })
              .strict(),
          )
          .max(32),
        shared_types: z
          .array(
            z.object({ name: text, file: path, consumers: strings }).strict(),
          )
          .max(32),
        events: z
          .array(
            z
              .object({
                name: text,
                producer: text,
                consumer: text,
                payload: text,
              })
              .strict(),
          )
          .max(32),
      })
      .strict(),
    key_files: z
      .array(
        z.object({ path, description: text, key_exports: strings }).strict(),
      )
      .max(32),
    recent_changes: strings,
  })
  .strict();
export type GeneratedKnowledge = z.infer<typeof generatedKnowledgeSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/),
  uuid = z.uuid().refine((value) => value === value.toLowerCase()),
  revision = z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1);
export const knowledgeRefreshRequestSchema = z
  .object({ requestId: uuid, expectedRevision: revision, repositoryKey: hash })
  .strict();
export type KnowledgeRefreshRequest = z.infer<
  typeof knowledgeRefreshRequestSchema
>;
export const knowledgeReceiptSchema = z
  .object({
    projectId: z.string().regex(/^project-[a-f0-9-]{36}$/),
    requestId: uuid,
    requestHash: hash,
    repositoryKey: hash,
    state: z.enum([
      "reserved",
      "attempted",
      "candidate-saved",
      "publishing",
      "confirmed",
      "refused",
      "failed",
      "unknown",
    ]),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/),
    evidenceHash: hash,
    candidateHash: hash.nullable(),
    confirmedAt: z.iso.datetime().nullable(),
    message: z.string().min(1).max(1000),
    retainedExtensions: z.array(z.string().min(1).max(256)).max(100),
  })
  .strict();
export type KnowledgeReceipt = z.infer<typeof knowledgeReceiptSchema>;

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
/** A bounded JSON data tree; never accepts YAML tags, aliases, prototype keys, or executable values. */
export function checkedKnowledgeData(value: unknown): Record<string, unknown> {
  let count = 0;
  const seen = new WeakSet<object>();
  const visit = (node: unknown, depth: number) => {
    if (++count > 5000 || depth > 12)
      throw Error("Knowledge data exceeds its structural bound");
    if (
      node === null ||
      typeof node === "boolean" ||
      (typeof node === "number" && Number.isFinite(node))
    )
      return;
    if (typeof node === "string") {
      if (node.length > 16000) throw Error("Knowledge text exceeds its bound");
      return;
    }
    if (typeof node !== "object" || seen.has(node))
      throw Error("Knowledge contains unsupported values");
    seen.add(node);
    if (Array.isArray(node)) {
      if (node.length > 1000) throw Error("Knowledge array exceeds its bound");
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (!record(node)) throw Error("Knowledge is not plain data");
    for (const [key, child] of Object.entries(node)) {
      if (
        !key ||
        key.length > 256 ||
        ["__proto__", "prototype", "constructor"].includes(key)
      )
        throw Error("Knowledge key is unsafe");
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  if (
    !record(value) ||
    Buffer.byteLength(JSON.stringify(value)) > KNOWLEDGE_LIMITS.documentBytes
  )
    throw Error("Knowledge document exceeds its bound");
  return value;
}

const itemFields: Record<string, readonly string[]> = {
  key_files: ["path", "description", "key_exports"],
  "integration_points.apis": [
    "endpoint",
    "method",
    "request",
    "response",
    "notes",
  ],
  "integration_points.shared_types": ["name", "file", "consumers"],
  "integration_points.events": ["name", "producer", "consumer", "payload"],
};
/** Regenerates canonical fields, retaining unknown legacy object fields. Ambiguous array extensions refuse. */
export function buildKnowledgeYaml(input: {
  generated: unknown;
  prior: unknown;
  name: string;
  sourceCommit: string;
  evidenceHash: string;
  generatedAt: string;
}): { text: string; retainedExtensions: string[] } {
  const generated = generatedKnowledgeSchema.parse(input.generated);
  if (generated.overview.name !== input.name)
    throw Error(
      "Generated repository name does not match the trusted repository",
    );
  z.string()
    .regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/)
    .parse(input.sourceCommit);
  hash.parse(input.evidenceHash);
  z.iso.datetime().parse(input.generatedAt);
  const prior = input.prior === null ? null : checkedKnowledgeData(input.prior),
    retainedExtensions: string[] = [];
  const merge = (old: unknown, fresh: unknown, location: string): unknown => {
    if (record(fresh)) {
      const result: Record<string, unknown> = record(old) ? { ...old } : {};
      if (record(old))
        for (const key of Object.keys(old))
          if (!Object.hasOwn(fresh, key))
            retainedExtensions.push(location ? `${location}.${key}` : key);
      for (const [key, value] of Object.entries(fresh))
        result[key] = merge(
          record(old) ? old[key] : undefined,
          value,
          location ? `${location}.${key}` : key,
        );
      return result;
    }
    if (Array.isArray(fresh) && old !== undefined) {
      if (!Array.isArray(old))
        throw Error(
          "Legacy extension data has an incompatible array shape; review it manually before refresh",
        );
      const fields = itemFields[location];
      if (fields) {
        for (const item of old) {
          if (
            !record(item) ||
            Object.keys(item).some((key) => !fields.includes(key))
          )
            throw Error(
              "Legacy extension fields inside arrays require manual review before refresh",
            );
          for (const [key, value] of Object.entries(item)) {
            if (key === "key_exports" || key === "consumers") {
              if (
                !Array.isArray(value) ||
                value.some((child) => typeof child !== "string")
              )
                throw Error(
                  "Legacy object-array extensions require manual review before refresh",
                );
            } else if (value !== null && typeof value === "object")
              throw Error(
                "Legacy extension data has an incompatible scalar shape; review it manually before refresh",
              );
          }
        }
      } else if (old.some((item) => typeof item !== "string"))
        throw Error(
          "Legacy object-array extensions require manual review before refresh",
        );
    }
    if (
      !Array.isArray(fresh) &&
      !record(fresh) &&
      old !== null &&
      typeof old === "object"
    )
      throw Error(
        "Legacy extension data has an incompatible scalar shape; review it manually before refresh",
      );
    return fresh;
  };
  const document = checkedKnowledgeData(merge(prior, generated, ""));
  const retained = [...new Set(retainedExtensions)].sort();
  if (retained.length > 100) throw Error("Too many legacy extension sections");
  const output =
    [
      "# Auto-generated repository knowledge",
      `# Last updated: ${input.generatedAt}`,
      `# Commit: ${input.sourceCommit}`,
      `# Bounded evidence: ${input.evidenceHash}`,
      "# Unobserved details are unknown; this is not a complete repository scan.",
      ...(retained.length
        ? [`# Retained unverified legacy extensions: ${retained.join(", ")}`]
        : []),
    ].join("\n") +
    "\n" +
    stringify(document, { lineWidth: 100, aliasDuplicateObjects: false });
  if (
    Buffer.byteLength(output) > KNOWLEDGE_LIMITS.documentBytes ||
    output.split("\n").length > KNOWLEDGE_LIMITS.lines
  )
    throw Error(
      "Generated knowledge exceeds the canonical byte or 400-line limit",
    );
  let roundTrip: unknown;
  try {
    roundTrip = parse(output, { uniqueKeys: true, maxAliasCount: 0 });
  } catch {
    throw Error("Generated knowledge did not round-trip as safe YAML");
  }
  if (JSON.stringify(roundTrip) !== JSON.stringify(document))
    throw Error("Generated knowledge changed during YAML serialization");
  return { text: output, retainedExtensions: retained };
}
