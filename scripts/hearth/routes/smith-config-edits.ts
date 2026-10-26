import type {
  SmithConfigEditPreview,
  SmithConfigEditPreviewRequest,
  SmithConfigEditReceipt,
  SmithConfigEditRequest,
} from "../../../types/smith-config-edit";
import { SmithEditJournalError } from "../../config/smith-edit-journal-core";
import { smithEditInputHash } from "../../config/smith-edit-journal-protocol";
import {
  SMITH_CONFIG_EDIT_LIMITS,
  smithConfigEditPreviewRequestSchema,
  smithConfigEditPreviewSchema,
  smithConfigEditReceiptSchema,
  smithConfigEditRequestIdSchema,
  smithConfigEditRequestSchema,
} from "../../config/smith-edit-protocol";
import type { ActionRoute, ReadRoute, RouteRequest } from "../api";
import { fail, noParameters } from "./operator-reads";

export interface SmithEditService {
  preview(value: unknown): SmithConfigEditPreview;
  edit(value: unknown): Promise<SmithConfigEditReceipt>;
  readOriginal(requestId: string): SmithConfigEditReceipt | null;
}

function previewRequest(
  request: RouteRequest,
):
  | { ok: true; value: SmithConfigEditPreviewRequest }
  | { ok: false; error: string } {
  const parameters = noParameters(request);
  if (!parameters.ok) return parameters;
  const checked = smithConfigEditPreviewRequestSchema.safeParse(request.body);
  return checked.success
    ? { ok: true, value: checked.data }
    : fail("Invalid Smith edit preview request.");
}

function editRequest(
  request: RouteRequest,
): { ok: true; value: SmithConfigEditRequest } | { ok: false; error: string } {
  const parameters = noParameters(request);
  if (!parameters.ok) return parameters;
  const checked = smithConfigEditRequestSchema.safeParse(request.body);
  return checked.success
    ? { ok: true, value: checked.data }
    : fail("Invalid Smith edit request.");
}

function publicPreview(
  value: SmithConfigEditPreview,
): SmithConfigEditPreview | null {
  const checked = smithConfigEditPreviewSchema.safeParse(value);
  return checked.success ? checked.data : null;
}

function publicReceipt(
  value: SmithConfigEditReceipt,
): SmithConfigEditReceipt | null {
  const checked = smithConfigEditReceiptSchema.safeParse(value);
  return checked.success ? checked.data : null;
}

/** Protected original reads and audited edit actions backed by one captured service. */
export function smithConfigEditRoutes(service: SmithEditService) {
  const original: ReadRoute<string> = {
    kind: "read",
    method: "GET",
    path: "/smiths/edits/:requestId",
    operatorOnly: true,
    validate(request) {
      const parameters = noParameters(request);
      if (!parameters.ok) return parameters;
      const checked = smithConfigEditRequestIdSchema.safeParse(
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
          return { status: 404, error: "No saved Smith edit original exists." };
        const checked = publicReceipt(receipt);
        return checked === null
          ? {
              status: 503,
              error: "The saved Smith edit original is unavailable.",
            }
          : { status: 200, data: checked };
      } catch {
        return {
          status: 503,
          error: "The saved Smith edit original is unavailable.",
        };
      }
    },
  };

  const preview: ActionRoute<SmithConfigEditPreviewRequest> = {
    kind: "action",
    method: "POST",
    path: "/config/smiths/edits/preview",
    action: "smith.config.edit.preview",
    maxBodyBytes: SMITH_CONFIG_EDIT_LIMITS.requestBytes,
    validate: previewRequest,
    subject: (input) => ({ family: "smith-config-edit", target: input.target }),
    effect(input) {
      try {
        const checked = publicPreview(service.preview(input));
        return checked === null
          ? { status: 503, error: "The Smith edit preview is unavailable." }
          : { status: 200, data: checked };
      } catch {
        return { status: 503, error: "The Smith edit preview is unavailable." };
      }
    },
  };

  const edit: ActionRoute<SmithConfigEditRequest> = {
    kind: "action",
    method: "POST",
    path: "/config/smiths/edits",
    action: "smith.config.edit",
    maxBodyBytes: SMITH_CONFIG_EDIT_LIMITS.requestBytes,
    validate: editRequest,
    subject: (input) => ({
      family: "smith-config-edit",
      target: input.target,
      requestId: input.requestId,
      inputHash: smithEditInputHash(input),
    }),
    async effect(input) {
      try {
        const checked = publicReceipt(await service.edit(input));
        if (checked === null)
          return {
            status: 503,
            error: "The Smith edit result is unavailable.",
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
          error instanceof SmithEditJournalError &&
          error.reason === "conflict"
        )
          return {
            status: 409,
            error: "The request ID belongs to a different saved Smith edit.",
          };
        return { status: 503, error: "The Smith edit result is unavailable." };
      }
    },
  };

  return { reads: [original], actions: [preview, edit] };
}
