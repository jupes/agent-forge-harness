import { createHash } from "node:crypto";
import {
  usageThresholdIntentSchema,
  usageThresholdRecoverySchema,
} from "../../../types/usage-threshold-intents";
import {
  MAX_USAGE_POLICY_REQUEST_BYTES,
  type UsageThresholdOriginal,
  type UsageThresholdRequest,
  usageThresholdDocumentSchema,
  usageThresholdJson,
  usageThresholdOriginalSchema,
  usageThresholdRecordSchema,
  usageThresholdRequestSchema,
} from "../../../types/usage-threshold-settings";
import { workspaceKey } from "../../projects/scope";
import {
  createUsageThresholdStore,
  MAX_USAGE_POLICY_BYTES,
  UsageThresholdError,
  type UsageThresholdReservationStore,
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
  ) => UsageThresholdReservationStore = createUsageThresholdStore,
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
      Buffer.byteLength(JSON.stringify(saved)) >
        MAX_USAGE_POLICY_REQUEST_BYTES ||
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
        raw = await store().applyReserved(id, request);
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
  function checkOriginal(row: {
    original: UsageThresholdOriginal;
    originalHash: string;
  }) {
    if (
      Buffer.byteLength(JSON.stringify(row.original)) >
        MAX_USAGE_POLICY_REQUEST_BYTES ||
      createHash("sha256")
        .update(usageThresholdJson(row.original))
        .digest("hex") !== row.originalHash
    )
      throw Error("Invalid usage original");
  }
  function checkedIntent(
    raw: unknown,
    id: string,
    requestId: string,
    original?: UsageThresholdRequest,
  ) {
    const result = usageThresholdIntentSchema.parse(raw);
    checkOriginal(result);
    if (
      result.original.projectId !== id ||
      result.original.workspace !== workspace ||
      result.original.requestId !== requestId ||
      Buffer.byteLength(JSON.stringify(result)) > MAX_USAGE_POLICY_BYTES ||
      (original &&
        usageThresholdJson(result.original) !==
          usageThresholdJson({ ...original, projectId: id }))
    )
      throw Error("Invalid usage intent");
    return result;
  }
  const recovery: ReadRoute<null> = {
    ...current,
    path: "/usage-threshold-settings/recovery",
    validate: noParameters,
    read() {
      let raw: unknown;
      try {
        raw = store().recovery();
      } catch (error) {
        return errorReply(error, false);
      }
      try {
        const result = usageThresholdRecoverySchema.parse(raw);
        for (const row of result.pending) checkOriginal(row);
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_USAGE_POLICY_BYTES)
          throw Error("Invalid usage recovery");
        return { status: 200, data: result };
      } catch {
        return errorReply(null, false);
      }
    },
  };
  const reservation: ReadRoute<{ projectId: string; requestId: string }> = {
    ...exact,
    path: exact.path + "/reservation",
    read({ projectId: id, requestId }) {
      let raw: unknown;
      try {
        raw = store().reservation(id, requestId);
      } catch (error) {
        return errorReply(error, false);
      }
      try {
        return { status: 200, data: checkedIntent(raw, id, requestId) };
      } catch {
        return errorReply(null, false);
      }
    },
  };
  async function intentEffect(
    operation: () => Promise<unknown>,
    id: string,
    request: UsageThresholdRequest,
    requireTerminal = false,
  ): Promise<RouteReply> {
    let raw: unknown;
    try {
      raw = await operation();
    } catch (error) {
      return errorReply(error, true);
    }
    try {
      const result = checkedIntent(raw, id, request.requestId, request);
      if (requireTerminal && result.phase === "reserved")
        throw Error("Invalid discard result");
      return { status: result.phase === "refused" ? 409 : 200, data: result };
    } catch {
      return errorReply(null, true);
    }
  }
  const reserve: typeof save = {
    ...save,
    path: save.path + "/requests",
    action: "usage.thresholds.reserve",
    effect: ({ projectId: id, request }) =>
      intentEffect(() => store().reserve(id, request), id, request),
  };
  const discard: typeof save = {
    ...save,
    path: exact.path + "/discard",
    action: "usage.thresholds.discard",
    validate(request) {
      const parsed = usageThresholdOriginalSchema.safeParse(request.body);
      if (!parsed.success)
        return fail("Expected the exact complete usage original.");
      const { projectId: id, ...body } = parsed.data;
      if (
        id !== request.params["id"] ||
        body.requestId !== request.params["requestId"]
      )
        return fail("Expected matching usage original identities.");
      return save.validate({ ...request, body });
    },
    effect: ({ projectId: id, request }) =>
      intentEffect(
        () =>
          store().discardReserved(id, request.requestId, {
            ...request,
            projectId: id,
          }),
        id,
        request,
        true,
      ),
  };
  return {
    reads: [current, exact, recovery, reservation] as const,
    actions: [save, reserve, discard] as const,
  };
}
