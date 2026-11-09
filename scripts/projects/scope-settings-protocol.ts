import { z } from "zod";
import {
  SOURCE_MAX_WORKSPACES,
  sourceEpicIdsSchema,
  sourceRefSchema,
} from "./connected-source-protocol";
export const scopeSelectionSchema = z
  .object({
    workspaceRef: sourceRefSchema,
    epicIds: sourceEpicIdsSchema.refine((ids) => ids.length > 0),
    grantId: z.uuid(),
    sourceInstanceId: z.uuid(),
    trackerId: z.uuid(),
    scopeCount: z.number().int().min(0).max(100000),
    scopeHash: sourceRefSchema,
  })
  .strict();
export const scopeSaveSchema = z
  .object({
    requestId: z.uuid(),
    expectedRevision: z.number().int().safe().nonnegative(),
    controllerId: z.uuid(),
    workspaces: z
      .array(scopeSelectionSchema)
      .min(1)
      .max(SOURCE_MAX_WORKSPACES)
      .refine(
        (values) =>
          new Set(values.map((value) => value.workspaceRef)).size ===
          values.length,
      ),
  })
  .strict();
export type ScopeSave = z.infer<typeof scopeSaveSchema>;
export const scopeSaveReceiptSchema = z
  .object({
    requestId: z.uuid(),
    projectId: z.string(),
    controllerId: z.uuid(),
    inputHash: sourceRefSchema,
    state: z.enum(["pending", "saved", "unavailable"]),
    catalogRevision: z.number().int().safe().nonnegative().nullable(),
    reason: z.string().max(2048).nullable(),
  })
  .strict()
  .refine((value) =>
    value.state === "saved"
      ? value.catalogRevision !== null && value.reason === null
      : value.catalogRevision === null && value.reason !== null,
  );
export type ScopeSaveReceipt = z.infer<typeof scopeSaveReceiptSchema>;
export function canonicalScopeSave(input: ScopeSave): ScopeSave {
  return {
    ...input,
    workspaces: input.workspaces
      .map((value) => ({ ...value, epicIds: [...value.epicIds].sort() }))
      .sort((a, b) => a.workspaceRef.localeCompare(b.workspaceRef)),
  };
}
