import { z } from "zod";
import type {
  SmithConfigCreateReceipt,
  SmithConfigCreateRequest,
  SmithConfigPreview,
  SmithConfigPreviewRequest,
  SmithCreateIdentityIndex,
} from "../../../types/smith-config-create";
import { SmithCreateJournalError } from "../../config/smith-create-journal-core";
import { smithCreateInputHash } from "../../config/smith-create-journal-protocol";
import {
  smithConfigCreateReceiptSchema,
  smithConfigCreateRequestSchema,
  smithConfigPreviewRequestSchema,
  smithConfigPreviewSchema,
  smithConfigRequestIdSchema,
  smithCreateIdentityIndexSchema,
} from "../../config/smith-create-protocol";
import type { ActionRoute, ReadRoute, RouteRequest } from "../api";
import { fail, noParameters } from "./operator-reads";

export interface SmithCreateService {
  preview(value: unknown): SmithConfigPreview;
  create(value: unknown): Promise<SmithConfigCreateReceipt>;
  readOriginal(requestId: string): SmithConfigCreateReceipt | null;
  reserveIdentity(value: unknown): Promise<SmithConfigCreateReceipt>;
  listIdentities(): SmithCreateIdentityIndex;
  retireReserved(
    requestId: string,
    inputHash: string,
  ): Promise<SmithConfigCreateReceipt>;
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

function reserveRequest(request: RouteRequest) {
  return createRequest(request);
}

const retireBodySchema = z
  .object({ inputHash: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

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

  const originals: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    path: "/smiths/creates",
    operatorOnly: true,
    validate(request) {
      return noParameters(request);
    },
    read() {
      try {
        const checked = smithCreateIdentityIndexSchema.safeParse(
          service.listIdentities(),
        );
        return checked.success
          ? { status: 200, data: checked.data }
          : {
              status: 503,
              error: "Saved Smith create identities are unavailable.",
            };
      } catch {
        return {
          status: 503,
          error: "Saved Smith create identities are unavailable.",
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
    subject: (input) => ({
      target: input.target,
      family: "smith-config-create",
      requestId: input.requestId,
      inputHash: smithCreateInputHash(input),
    }),
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

  const reserve: ActionRoute<SmithConfigCreateRequest> = {
    kind: "action",
    method: "POST",
    path: "/config/smiths/creates/reserve",
    action: "smith.config.create.reserve",
    validate: reserveRequest,
    subject: (input) => ({
      target: input.target,
      family: "smith-config-create",
      requestId: input.requestId,
      inputHash: smithCreateInputHash(input),
    }),
    async effect(input) {
      try {
        const checked = publicReceipt(await service.reserveIdentity(input));
        if (checked === null)
          return {
            status: 503,
            error: "The Smith create reservation is unavailable.",
          };
        return {
          status: checked.result.phase === "refused" ? 409 : 200,
          data: checked,
        };
      } catch (error) {
        if (
          error instanceof SmithCreateJournalError &&
          error.reason === "conflict"
        )
          return {
            status: 409,
            error: "A different Smith create is unresolved for this owner.",
          };
        return {
          status: 503,
          error: "The Smith create reservation is unavailable.",
        };
      }
    },
  };

  const retire: ActionRoute<{ requestId: string; inputHash: string }> = {
    kind: "action",
    method: "POST",
    path: "/config/smiths/creates/:requestId/retire",
    action: "smith.config.create.retire",
    validate(request) {
      const parameters = noParameters({ ...request, params: {} });
      if (!parameters.ok) return parameters;
      const id = smithConfigRequestIdSchema.safeParse(request.params.requestId),
        body = retireBodySchema.safeParse(request.body);
      return id.success && body.success
        ? {
            ok: true,
            value: { requestId: id.data, inputHash: body.data.inputHash },
          }
        : fail("Invalid Smith create retirement request.");
    },
    subject: ({ requestId, inputHash }) => ({
      family: "smith-config-create",
      requestId,
      inputHash,
    }),
    async effect({ requestId, inputHash }) {
      try {
        const checked = publicReceipt(
          await service.retireReserved(requestId, inputHash),
        );
        return checked === null
          ? {
              status: 503,
              error: "The Smith create retirement is unavailable.",
            }
          : {
              status:
                checked.result.phase === "refused" &&
                checked.result.reason === "cancelled-before-attempt"
                  ? 200
                  : 409,
              data: checked,
            };
      } catch {
        return {
          status: 503,
          error: "The Smith create retirement is unavailable.",
        };
      }
    },
  };

  return {
    reads: [original, originals],
    actions: [preview, reserve, create, retire],
  };
}
