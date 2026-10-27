import { z } from "zod";
import {
  NotSent,
  type operatorPost,
  type operatorRead,
} from "../../../docs/js/operator";
import {
  canonicalSmithConfigCreateRequest,
  smithConfigCreateReceiptSchema,
  smithCreateIdentityIndexSchema,
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
const reservationPath = "/__agent-forge/config/smiths/creates/reserve";
const identityPath = "/__agent-forge/smiths/creates";
const responseBytes = { maxBodyBytes: 65_536 };
const identityResponseBytes = { maxBodyBytes: 524_288 };

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
    async reserve(
      request: SmithConfigCreateRequest,
    ): Promise<SmithCreatePostResult> {
      try {
        const response = await deps.post(
            reservationPath,
            request,
            responseBytes,
          ),
          raw: unknown = await response.json().catch(() => null),
          parsedEnvelope = envelope.safeParse(raw),
          receipt = parsedEnvelope.success
            ? smithConfigCreateReceiptSchema.safeParse(parsedEnvelope.data.data)
            : null;
        if (response.status === 403)
          return {
            state: "not-sent",
            message:
              "Operator access refused this reservation before its effect.",
          };
        if (
          receipt?.success &&
          response.status === 200 &&
          receipt.data.requestId === request.requestId &&
          canonicalSmithConfigCreateRequest(receipt.data.original) ===
            canonicalSmithConfigCreateRequest(request) &&
          receipt.data.result.phase === "held" &&
          receipt.data.result.stage === "reserved"
        )
          return { state: "sent", value: raw };
        return {
          state: "unknown",
          message: "The server did not return a verified reservation.",
        };
      } catch (error) {
        return error instanceof NotSent
          ? { state: "not-sent", message: error.message }
          : {
              state: "unknown",
              message: "The reservation may have reached the server.",
            };
      }
    },
    async list(): Promise<unknown> {
      const response = await deps.read(
        identityPath,
        { method: "GET" },
        identityResponseBytes,
      );
      if (response.status !== 200)
        throw Error("Saved Smith create identities could not be verified.");
      const raw: unknown = await response.json(),
        parsedEnvelope = envelope.safeParse(raw),
        checked = smithCreateIdentityIndexSchema.safeParse(
          parsedEnvelope.success ? parsedEnvelope.data.data : null,
        );
      if (!checked?.success)
        throw Error("Saved Smith create identities could not be verified.");
      return checked.data;
    },
    async retireReserved(
      requestId: string,
      inputHash: string,
    ): Promise<unknown> {
      const response = await deps.post(
        `${reservationPath.replace(/\/reserve$/, "")}/${encodeURIComponent(requestId)}/retire`,
        { inputHash },
        responseBytes,
      );
      if (response.status !== 200)
        throw Error("The reserved Smith create could not be retired.");
      return response.json() as Promise<unknown>;
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
