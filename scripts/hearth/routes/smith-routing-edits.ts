import type {
  SmithRoutingEditPreview,
  SmithRoutingEditPreviewRequest,
  SmithRoutingEditReceipt,
  SmithRoutingEditRequest,
} from "../../../types/smith-routing-edit";
import { SmithRoutingEditJournalError } from "../../config/smith-routing-edit-journal-core";
import {
  smithRoutingEditInputHash,
  smithRoutingEditReceiptSchema,
} from "../../config/smith-routing-edit-journal-protocol";
import {
  SMITH_ROUTING_EDIT_LIMITS,
  smithRoutingEditPreviewRequestSchema,
  smithRoutingEditPreviewSchema,
  smithRoutingEditRequestIdSchema,
  smithRoutingEditRequestSchema,
} from "../../config/smith-routing-edit-protocol";
import type { ActionRoute, ReadRoute, RouteRequest } from "../api";
import { fail, noParameters } from "./operator-reads";

export interface SmithRoutingEditService {
  preview(value: unknown): SmithRoutingEditPreview;
  edit(value: unknown): Promise<SmithRoutingEditReceipt>;
  readOriginal(requestId: string): SmithRoutingEditReceipt | null;
}

function previewRequest(
  request: RouteRequest,
):
  | { ok: true; value: SmithRoutingEditPreviewRequest }
  | { ok: false; error: string } {
  const parameters = noParameters(request);
  if (!parameters.ok) return parameters;
  const checked = smithRoutingEditPreviewRequestSchema.safeParse(request.body);
  return checked.success
    ? { ok: true, value: checked.data }
    : fail("Invalid routing edit preview request.");
}

function editRequest(
  request: RouteRequest,
): { ok: true; value: SmithRoutingEditRequest } | { ok: false; error: string } {
  const parameters = noParameters(request);
  if (!parameters.ok) return parameters;
  const checked = smithRoutingEditRequestSchema.safeParse(request.body);
  return checked.success
    ? { ok: true, value: checked.data }
    : fail("Invalid routing edit request.");
}

function publicPreview(
  value: SmithRoutingEditPreview,
): SmithRoutingEditPreview | null {
  const checked = smithRoutingEditPreviewSchema.safeParse(value);
  return checked.success ? checked.data : null;
}

function publicReceipt(
  value: SmithRoutingEditReceipt,
): SmithRoutingEditReceipt | null {
  const checked = smithRoutingEditReceiptSchema.safeParse(value);
  return checked.success ? checked.data : null;
}

function auditSelector(change: SmithRoutingEditPreviewRequest["change"]) {
  return {
    changeKind: change.kind,
    selector:
      change.kind === "default" ? "workflow.default_crew" : change.bench,
  } as const;
}

/** Protected routing originals and audited actions backed by one captured service. */
export function smithRoutingEditRoutes(service: SmithRoutingEditService) {
  const original: ReadRoute<string> = {
    kind: "read",
    method: "GET",
    path: "/smiths/routing-edits/:requestId",
    operatorOnly: true,
    validate(request) {
      const parameters = noParameters(request);
      if (!parameters.ok) return parameters;
      const checked = smithRoutingEditRequestIdSchema.safeParse(
        request.params.requestId,
      );
      return checked.success
        ? { ok: true, value: checked.data }
        : fail("requestId must be a lowercase UUID.");
    },
    read(requestId) {
      try {
        const receipt = service.readOriginal(requestId);
        if (receipt === null)
          return {
            status: 404,
            error: "No saved routing edit original exists.",
          };
        const checked = publicReceipt(receipt);
        return checked === null
          ? {
              status: 503,
              error: "The saved routing edit original is unavailable.",
            }
          : { status: 200, data: checked };
      } catch {
        return {
          status: 503,
          error: "The saved routing edit original is unavailable.",
        };
      }
    },
  };

  const preview: ActionRoute<SmithRoutingEditPreviewRequest> = {
    kind: "action",
    method: "POST",
    path: "/config/smiths/routing-edits/preview",
    action: "smith.config.routing-edit.preview",
    maxBodyBytes: SMITH_ROUTING_EDIT_LIMITS.requestBytes,
    validate: previewRequest,
    subject: (input) => ({
      family: "smith-routing-edit",
      target: input.target,
      ...auditSelector(input.change),
    }),
    effect(input) {
      try {
        const checked = publicPreview(service.preview(input));
        return checked === null
          ? {
              status: 503,
              error: "The routing edit preview is unavailable.",
            }
          : { status: 200, data: checked };
      } catch {
        return {
          status: 503,
          error: "The routing edit preview is unavailable.",
        };
      }
    },
  };

  const edit: ActionRoute<SmithRoutingEditRequest> = {
    kind: "action",
    method: "POST",
    path: "/config/smiths/routing-edits",
    action: "smith.config.routing-edit",
    maxBodyBytes: SMITH_ROUTING_EDIT_LIMITS.requestBytes,
    validate: editRequest,
    subject: (input) => ({
      family: "smith-routing-edit",
      target: input.target,
      requestId: input.requestId,
      inputHash: smithRoutingEditInputHash(input),
      ...auditSelector(input.change),
    }),
    async effect(input) {
      try {
        const checked = publicReceipt(await service.edit(input));
        if (checked === null)
          return {
            status: 503,
            error: "The routing edit result is unavailable.",
          };
        return {
          status:
            checked.result.phase === "confirmed"
              ? 200
              : checked.result.phase === "held"
                ? 202
                : 409,
          data: checked,
        };
      } catch (error) {
        if (
          error instanceof SmithRoutingEditJournalError &&
          error.reason === "conflict"
        )
          return {
            status: 409,
            error: "The request ID belongs to a different saved routing edit.",
          };
        return {
          status: 503,
          error: "The routing edit result is unavailable.",
        };
      }
    },
  };

  return { reads: [original], actions: [preview, edit] };
}
