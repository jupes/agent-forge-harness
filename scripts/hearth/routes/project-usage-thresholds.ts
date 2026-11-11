import { createHash } from "node:crypto";
import {
  MAX_USAGE_POLICY_REQUEST_BYTES,
  type UsageThresholdRequest,
  usageThresholdDocumentSchema,
  usageThresholdJson,
  usageThresholdRecordSchema,
  usageThresholdRequestSchema,
} from "../../../types/usage-threshold-settings";
import { workspaceKey } from "../../projects/scope";
import {
  createUsageThresholdStore,
  UsageThresholdError,
  type UsageThresholdStore,
} from "../../projects/usage-threshold-store";
import type { ActionRoute, ReadRoute, RouteReply, RouteRequest } from "../api";
import type { ValidationResult } from "../validate";
import { fail, noParameters } from "./operator-reads";

const messages = {
  400: "Expected complete explicit usage threshold settings.",
  404: "The requested usage settings or exact saved original are unavailable.",
  409: "Usage threshold settings conflict with the current project scope or original.",
  503: "Private usage threshold settings are unavailable.",
  504: "Usage threshold settings may have changed. Check the exact saved original before continuing.",
} as const;

function errorReply(error: unknown, writing: boolean): RouteReply {
  let status: keyof typeof messages = writing ? 504 : 503;
  try {
    if (error instanceof UsageThresholdError) {
      const descriptor = Object.getOwnPropertyDescriptor(error, "status");
      const value: unknown =
        descriptor && "value" in descriptor ? descriptor.value : null;
      if (
        value === 400 ||
        value === 404 ||
        value === 409 ||
        value === 503 ||
        value === 504
      )
        status = value;
    }
  } catch {
    // An unknown thrown object cannot supply response text or authority.
  }
  return { status, error: messages[status] };
}

function projectId(request: RouteRequest): ValidationResult<string> {
  const empty = noParameters(request);
  if (!empty.ok) return empty;
  const parsed =
    usageThresholdRecordSchema.shape.document.shape.projectId.safeParse(
      request.params["id"],
    );
  return parsed.success
    ? { ok: true, value: parsed.data }
    : fail("Expected a project identity.");
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

export function createUsageThresholdRoutes(
  home: string,
  servedWorkspace: string,
  storeFactory: (
    home: string,
    workspace: string,
  ) => UsageThresholdStore = createUsageThresholdStore,
) {
  const workspace = workspaceKey(servedWorkspace);
  const store = () => storeFactory(home, workspace);
  function checkedRecord(
    raw: unknown,
    id: string,
    requestId: string,
    original?: UsageThresholdRequest,
  ) {
    const result = usageThresholdRecordSchema.parse(raw);
    const saved = result.receipt.original;
    if (
      saved.projectId !== id ||
      saved.workspace !== workspace ||
      saved.requestId !== requestId ||
      result.receipt.originalHash !==
        createHash("sha256").update(usageThresholdJson(saved)).digest("hex") ||
      (original &&
        usageThresholdJson(saved) !==
          usageThresholdJson({ ...original, projectId: id }))
    )
      throw Error("Invalid usage settings response");
    return result;
  }
  const current: ReadRoute<string> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/settings/usage-thresholds",
    operatorOnly: true,
    validate: projectId,
    read(id) {
      let raw: unknown;
      try {
        raw = store().read(id);
      } catch (error) {
        return errorReply(error, false);
      }
      try {
        const document = usageThresholdDocumentSchema.parse(raw);
        if (document.projectId !== id || document.workspace !== workspace)
          throw Error("Invalid usage settings scope");
        return { status: 200, data: document };
      } catch {
        return errorReply(null, false);
      }
    },
  };
  const exact: ReadRoute<{ projectId: string; requestId: string }> = {
    kind: "read",
    method: "GET",
    path: "/projects/:id/settings/usage-thresholds/requests/:requestId",
    operatorOnly: true,
    validate(request) {
      const id = projectId(request);
      if (!id.ok) return id;
      const parsed = usageThresholdRequestSchema.shape.requestId.safeParse(
        request.params["requestId"],
      );
      return parsed.success
        ? { ok: true, value: { projectId: id.value, requestId: parsed.data } }
        : fail("Expected a saved usage settings request UUID.");
    },
    read({ projectId: id, requestId }) {
      let raw: unknown;
      try {
        raw = store().original(id, requestId);
      } catch (error) {
        return errorReply(error, false);
      }
      try {
        return {
          status: 200,
          data: checkedRecord(raw, id, requestId),
        };
      } catch {
        return errorReply(null, false);
      }
    },
  };
  const save: ActionRoute<{
    projectId: string;
    request: UsageThresholdRequest;
  }> = {
    kind: "action",
    method: "POST",
    path: "/projects/:id/settings/usage-thresholds",
    operatorOnly: true,
    action: "usage.thresholds.set",
    rejectDuplicateBodyKeys: true,
    maxBodyBytes: MAX_USAGE_POLICY_REQUEST_BYTES,
    validate(request) {
      const id = projectId(request);
      if (!id.ok) return id;
      const parsed = usageThresholdRequestSchema.safeParse(request.body);
      return parsed.success && parsed.data.workspace === workspace
        ? {
            ok: true,
            value: freeze({
              projectId: id.value,
              request: structuredClone(parsed.data),
            }),
          }
        : fail("Expected complete usage settings for the served workspace.");
    },
    subject: ({ projectId: id, request }) => ({
      target: id,
      family: "usage-threshold-settings",
      requestId: request.requestId,
    }),
    async effect({ projectId: id, request }) {
      let raw: unknown;
      try {
        raw = await store().write(id, request);
      } catch (error) {
        return errorReply(error, true);
      }
      try {
        const result = checkedRecord(raw, id, request.requestId, request);
        return {
          status: result.receipt.outcome === "refused" ? 409 : 200,
          data: result,
        };
      } catch {
        return errorReply(null, true);
      }
    },
  };
  return { reads: [current, exact] as const, actions: [save] as const };
}
