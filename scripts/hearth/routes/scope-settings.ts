import { createHash } from "node:crypto";
import { z } from "zod";
import { sourceProjectIdSchema } from "../../projects/connected-source-protocol";
import {
  canonicalScopeSave,
  scopeSaveSchema,
} from "../../projects/scope-settings-protocol";
import type { ScopeSettings } from "../../projects/scope-settings-service";
import { ProjectStoreError } from "../../projects/store";
import type { ActionRoute, ReadRoute, RouteReply } from "../api";
import { fail } from "./operator-reads";

const inputSchema = z
  .object({ id: sourceProjectIdSchema, request: scopeSaveSchema })
  .strict();
const originalSchema = z
  .object({ id: sourceProjectIdSchema, requestId: z.uuid() })
  .strict();
async function answer(
  work: () => unknown | Promise<unknown>,
): Promise<RouteReply> {
  try {
    return { status: 200, data: await work() };
  } catch (error) {
    return error instanceof ProjectStoreError
      ? { status: error.status, error: error.message }
      : {
          status: 503,
          error:
            "Scope Save could not be verified. Check its original before any new request.",
        };
  }
}
export function scopeSettingsRoutes(service: ScopeSettings) {
  const save: ActionRoute<z.infer<typeof inputSchema>> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/settings/scope",
    action: "project.scope.save",
    maxBodyBytes: 65536,
    rejectDuplicateBodyKeys: true,
    validate: (request) => {
      const parsed = inputSchema.safeParse({
        id: request.params.id,
        request: request.body,
      });
      return !request.query.size && parsed.success
        ? { ok: true, value: parsed.data }
        : fail(
            "Select and review exactly every workspace Scope before saving.",
          );
    },
    subject: (input) => ({
      target: input.id,
      family: "project-scope-save",
      requestId: input.request.requestId,
      inputHash: createHash("sha256")
        .update(JSON.stringify(canonicalScopeSave(input.request)))
        .digest("hex"),
    }),
    effect: (input) => answer(() => service.save(input.id, input.request)),
  };
  const original: ReadRoute<z.infer<typeof originalSchema>> = {
    kind: "read",
    method: "GET",
    operatorOnly: true,
    path: "/projects/:id/settings/scope/requests/:requestId",
    validate: (request) => {
      const parsed = originalSchema.safeParse(request.params);
      return !request.query.size && parsed.success
        ? { ok: true, value: parsed.data }
        : fail("Invalid Scope Save original.");
    },
    read: (input) => answer(() => service.original(input.id, input.requestId)),
  };
  return { save, original };
}
