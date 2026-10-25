import type {
  SmithConfigCreateReceipt,
  SmithConfigCreateRequest,
  SmithConfigPreview,
  SmithConfigPreviewRequest,
} from "../../../types/smith-config-create";
import { SmithCreateJournalError } from "../../config/smith-create-journal-core";
import {
  smithConfigCreateReceiptSchema,
  smithConfigCreateRequestSchema,
  smithConfigPreviewRequestSchema,
  smithConfigPreviewSchema,
  smithConfigRequestIdSchema,
} from "../../config/smith-create-protocol";
import type { ActionRoute, ReadRoute, RouteRequest } from "../api";
import { fail, noParameters } from "./operator-reads";

export interface SmithCreateService {
  preview(value: unknown): SmithConfigPreview;
  create(value: unknown): Promise<SmithConfigCreateReceipt>;
  readOriginal(requestId: string): SmithConfigCreateReceipt | null;
}

function previewRequest(
  request: RouteRequest,
):
  | { ok: true; value: SmithConfigPreviewRequest }
  | { ok: false; error: string } {
  const parameters = noParameters(request);
  if (!parameters.ok) return parameters;
  const checked = smithConfigPreviewRequestSchema.safeParse(request.body);
  return checked.success
    ? { ok: true, value: checked.data }
    : fail("Invalid Smith create preview request.");
}

function createRequest(
  request: RouteRequest,
):
  | { ok: true; value: SmithConfigCreateRequest }
  | { ok: false; error: string } {
  const parameters = noParameters(request);
  if (!parameters.ok) return parameters;
  const checked = smithConfigCreateRequestSchema.safeParse(request.body);
  return checked.success
    ? { ok: true, value: checked.data }
    : fail("Invalid Smith create request.");
}

function publicPreview(value: SmithConfigPreview): SmithConfigPreview | null {
  const checked = smithConfigPreviewSchema.safeParse(value);
  return checked.success ? checked.data : null;
}

function publicReceipt(
  value: SmithConfigCreateReceipt,
): SmithConfigCreateReceipt | null {
  const checked = smithConfigCreateReceiptSchema.safeParse(value);
  return checked.success ? checked.data : null;
}

/** Protected original reads and audited actions backed by one captured service. */
export function smithConfigCreateRoutes(service: SmithCreateService) {
  const original: ReadRoute<string> = {
    kind: "read",
    method: "GET",
    path: "/smiths/creates/:requestId",
    operatorOnly: true,
    validate(request) {
      const parameters = noParameters(request);
      if (!parameters.ok) return parameters;
      const checked = smithConfigRequestIdSchema.safeParse(
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
            error: "No saved Smith create original exists.",
          };
        const checked = publicReceipt(receipt);
        return checked === null
          ? {
              status: 503,
              error: "The saved Smith create original is unavailable.",
            }
          : { status: 200, data: checked };
      } catch {
        return {
          status: 503,
          error: "The saved Smith create original is unavailable.",
        };
      }
    },
  };

  const preview: ActionRoute<SmithConfigPreviewRequest> = {
    kind: "action",
    method: "POST",
    path: "/config/smiths/preview",
    action: "smith.config.preview",
    validate: previewRequest,
    subject: (input) => ({ target: input.target }),
    effect(input) {
      try {
        const checked = publicPreview(service.preview(input));
        return checked === null
          ? { status: 503, error: "The Smith config preview is unavailable." }
          : { status: 200, data: checked };
      } catch {
        return {
          status: 503,
          error: "The Smith config preview is unavailable.",
        };
      }
    },
  };

  const create: ActionRoute<SmithConfigCreateRequest> = {
    kind: "action",
    method: "POST",
    path: "/config/smiths/creates",
    action: "smith.config.create",
    validate: createRequest,
    subject: (input) => ({ target: input.target }),
    async effect(input) {
      try {
        const checked = publicReceipt(await service.create(input));
        if (checked === null)
          return {
            status: 503,
            error: "The Smith create result is unavailable.",
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
        // The UUID is already owned by another exact original. Preserve that
        // distinction without exposing either stored or submitted content.
        // Corrupt and uncertain histories remain generic held responses.
        if (
          error instanceof SmithCreateJournalError &&
          error.reason === "conflict"
        )
          return {
            status: 409,
            error: "The request ID belongs to a different saved Smith create.",
          };
        return {
          status: 503,
          error: "The Smith create result is unavailable.",
        };
      }
    },
  };

  return { reads: [original], actions: [preview, create] };
}
