import { z } from "zod";
import {
  NotSent,
  type operatorPost,
  type operatorRead,
} from "../../../docs/js/operator";
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

/** Exact public paths and response truth for the Smith create client. */
export function createSmithCreateApi(deps: {
  post: typeof operatorPost;
  read: typeof operatorRead;
}) {
  return {
    async preview(input: SmithConfigPreviewRequest): Promise<unknown> {
      const response = await deps.post(previewPath, input);
      return response.json() as Promise<unknown>;
    },
    async create(
      request: SmithConfigCreateRequest,
    ): Promise<SmithCreatePostResult> {
      try {
        const response = await deps.post(createPath, request),
          raw: unknown = await response.json().catch(() => null);
        if (response.status === 403)
          return {
            state: "not-sent",
            message: "Operator access refused this request before its effect.",
          };
        if (
          (response.status === 200 ||
            response.status === 202 ||
            response.status === 409) &&
          envelope.safeParse(raw).success
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
      return response.json() as Promise<unknown>;
    },
  };
}
