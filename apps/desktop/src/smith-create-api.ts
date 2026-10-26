import { z } from "zod";
import {
  NotSent,
  type operatorPost,
  type operatorRead,
} from "../../../docs/js/operator";
import {
  canonicalSmithConfigCreateRequest,
  smithConfigCreateReceiptSchema,
} from "../../../scripts/config/smith-create-protocol";
import type {
  SmithConfigCreateRequest,
  SmithConfigPreviewRequest,
} from "../../../types/smith-config-create";
import type { SmithCreatePostResult } from "./smith-create-client";

const envelope = z
  .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
  .strict();
const previewPath = "/__agent-forge/config/smiths/preview";
const createPath = "/__agent-forge/config/smiths/creates";
const originalPath = "/__agent-forge/smiths/creates";
const responseBytes = { maxBodyBytes: 65_536 };

const expectedCreateStatus = {
  confirmed: 200,
  held: 202,
  refused: 409,
} as const;

/** Exact public paths and response truth for the Smith create client. */
export function createSmithCreateApi(deps: {
  post: typeof operatorPost;
  read: typeof operatorRead;
}) {
  return {
    async preview(input: SmithConfigPreviewRequest): Promise<unknown> {
      const response = await deps.post(previewPath, input, responseBytes);
      if (response.status !== 200)
        throw Error("The Smith preview could not be verified.");
      return response.json() as Promise<unknown>;
    },
    async create(
      request: SmithConfigCreateRequest,
    ): Promise<SmithCreatePostResult> {
      try {
        const response = await deps.post(createPath, request, responseBytes),
          raw: unknown = await response.json().catch(() => null);
        if (response.status === 403)
          return {
            state: "not-sent",
            message: "Operator access refused this request before its effect.",
          };
        const parsedEnvelope = envelope.safeParse(raw);
        const parsedReceipt = parsedEnvelope.success
          ? smithConfigCreateReceiptSchema.safeParse(parsedEnvelope.data.data)
          : null;
        if (
          parsedReceipt?.success &&
          response.status ===
            expectedCreateStatus[parsedReceipt.data.result.phase] &&
          parsedReceipt.data.requestId === request.requestId &&
          canonicalSmithConfigCreateRequest(parsedReceipt.data.original) ===
            canonicalSmithConfigCreateRequest(request)
        )
          return { state: "sent", value: raw };
        return {
          state: "unknown",
          message: "The server did not return a verified create receipt.",
        };
      } catch (error) {
        return error instanceof NotSent
          ? { state: "not-sent", message: error.message }
          : {
              state: "unknown",
              message: "The create request may have reached the server.",
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
        throw Error("The saved Smith original could not be verified.");
      return response.json() as Promise<unknown>;
    },
  };
}
