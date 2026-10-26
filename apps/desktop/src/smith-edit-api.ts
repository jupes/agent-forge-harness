import { z } from "zod";
import {
  NotSent,
  type operatorPost,
  type operatorRead,
} from "../../../docs/js/operator";
import {
  canonicalSmithConfigEditRequest,
  smithConfigEditReceiptSchema,
} from "../../../scripts/config/smith-edit-protocol";
import type {
  SmithConfigEditPreviewRequest,
  SmithConfigEditRequest,
} from "../../../types/smith-config-edit";

const verifiedNotSentToken = Symbol("verified Smith edit NotSent");
interface VerifiedSmithEditNotSent {
  readonly state: "not-sent";
  readonly requestId: string;
  readonly message: string;
  readonly [verifiedNotSentToken]: true;
}
export type SmithEditPostResult =
  | VerifiedSmithEditNotSent
  | { state: "sent"; value: unknown }
  | { state: "unknown"; message: string };

export function isVerifiedSmithEditNotSent(
  value: SmithEditPostResult,
  requestId: string,
): value is VerifiedSmithEditNotSent {
  return (
    value.state === "not-sent" &&
    value.requestId === requestId &&
    value[verifiedNotSentToken] === true
  );
}

const verifiedNotSent = (
  requestId: string,
  message: string,
): VerifiedSmithEditNotSent => ({
  state: "not-sent",
  requestId,
  message,
  [verifiedNotSentToken]: true,
});
const envelope = z
  .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
  .strict();
const previewPath = "/__agent-forge/config/smiths/edits/preview";
const editPath = "/__agent-forge/config/smiths/edits";
const originalPath = "/__agent-forge/smiths/edits";
const responseBytes = { maxBodyBytes: 65_536 };
const expectedStatus = { confirmed: 200, held: 202, refused: 409 } as const;

/** Edit-only route binding; source-specific NotSent is branded inside this helper. */
export function createSmithEditApi(deps: {
  post: typeof operatorPost;
  read: typeof operatorRead;
}) {
  return {
    async preview(input: SmithConfigEditPreviewRequest): Promise<unknown> {
      const response = await deps.post(previewPath, input, responseBytes);
      if (response.status !== 200)
        throw Error("The Smith edit preview could not be verified.");
      return response.json() as Promise<unknown>;
    },
    async edit(request: SmithConfigEditRequest): Promise<SmithEditPostResult> {
      try {
        const response = await deps.post(editPath, request, responseBytes);
        const raw: unknown = await response.json().catch(() => null);
        if (response.status === 403)
          return verifiedNotSent(
            request.requestId,
            "Operator access refused this edit before its effect.",
          );
        const parsedEnvelope = envelope.safeParse(raw);
        const parsedReceipt = parsedEnvelope.success
          ? smithConfigEditReceiptSchema.safeParse(parsedEnvelope.data.data)
          : null;
        if (
          parsedReceipt?.success &&
          response.status === expectedStatus[parsedReceipt.data.result.phase] &&
          parsedReceipt.data.requestId === request.requestId &&
          canonicalSmithConfigEditRequest(parsedReceipt.data.original) ===
            canonicalSmithConfigEditRequest(request)
        )
          return { state: "sent", value: raw };
        return {
          state: "unknown",
          message: "The server did not return a verified Smith edit receipt.",
        };
      } catch (error) {
        return error instanceof NotSent
          ? verifiedNotSent(request.requestId, error.message)
          : {
              state: "unknown",
              message: "The Smith edit request may have reached the server.",
            };
      }
    },
    async original(requestId: string): Promise<unknown> {
      const response = await deps.read(
        `${originalPath}/${encodeURIComponent(requestId)}`,
        { method: "GET" },
        responseBytes,
      );
      if (response.status !== 200)
        throw Error("The saved Smith edit original could not be verified.");
      return response.json() as Promise<unknown>;
    },
  };
}
