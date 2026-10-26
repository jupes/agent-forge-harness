import { z } from "zod";
import {
  NotSent,
  type operatorPost,
  type operatorRead,
} from "../../../docs/js/operator";
import {
  canonicalSmithRoutingEditRequest,
  smithRoutingEditPreviewRequestSchema,
  smithRoutingEditReceiptSchema,
  smithRoutingEditRequestIdSchema,
  smithRoutingEditRequestSchema,
} from "../../../scripts/config/smith-routing-edit-protocol";
import type {
  SmithRoutingEditPreviewRequest,
  SmithRoutingEditRequest,
} from "../../../types/smith-routing-edit";
import { smithRoutingEditInputHash } from "./smith-routing-edit-identities";

const verifiedNotSentToken = Symbol("verified Smith routing edit NotSent");
export type SmithRoutingEditNotSent = {
  readonly state: "not-sent";
  readonly requestId: string;
  readonly scope: string;
  readonly inputHash: string;
  readonly message: string;
  readonly [verifiedNotSentToken]: true;
};
export type SmithRoutingEditPostResult =
  | SmithRoutingEditNotSent
  | { state: "sent"; value: unknown }
  | { state: "unknown"; message: string };
export function isVerifiedSmithRoutingEditNotSent(
  value: SmithRoutingEditPostResult,
  expected: { requestId: string; scope: string; inputHash: string },
): value is SmithRoutingEditNotSent {
  return (
    value.state === "not-sent" &&
    value.requestId === expected.requestId &&
    value.scope === expected.scope &&
    value.inputHash === expected.inputHash &&
    value[verifiedNotSentToken] === true
  );
}
const verifiedNotSent = (
  expected: { requestId: string; scope: string; inputHash: string },
  message: string,
): SmithRoutingEditNotSent => ({
  state: "not-sent",
  ...expected,
  message,
  [verifiedNotSentToken]: true,
});
const envelope = z
  .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
  .strict();
const previewPath = "/__agent-forge/config/smiths/routing-edits/preview";
const editPath = "/__agent-forge/config/smiths/routing-edits";
const originalPath = "/__agent-forge/smiths/routing-edits";
const responseBytes = { maxBodyBytes: 65_536 };
const expectedStatus = { held: 202, confirmed: 200, refused: 409 } as const;

/** Browser transport for the routing edit family; paths and NotSent proof are fixed here. */
export function createSmithRoutingEditApi(deps: {
  post: typeof operatorPost;
  read: typeof operatorRead;
  scope(): string;
  canWrite(): boolean;
}) {
  return {
    async preview(input: SmithRoutingEditPreviewRequest): Promise<unknown> {
      const checked = smithRoutingEditPreviewRequestSchema.parse(
        structuredClone(input),
      );
      const response = await deps.post(previewPath, checked, responseBytes);
      if (response.status !== 200)
        throw Error("The routing edit preview could not be verified.");
      return response.json() as Promise<unknown>;
    },
    async edit(
      request: SmithRoutingEditRequest,
      reserved: { scope: string; inputHash: string },
    ): Promise<SmithRoutingEditPostResult> {
      let original: SmithRoutingEditRequest;
      try {
        original = smithRoutingEditRequestSchema.parse(
          structuredClone(request),
        );
      } catch {
        return {
          state: "unknown",
          message: "The exact routing edit request could not be verified.",
        };
      }
      const proof = {
        requestId: original.requestId,
        scope: reserved.scope,
        inputHash: reserved.inputHash,
      };
      if (
        !/^[a-f0-9]{64}$/.test(proof.inputHash) ||
        !proof.scope ||
        proof.scope.length > 512
      )
        return {
          state: "unknown",
          message: "The routing edit reservation could not be verified.",
        };
      let calculated: string;
      try {
        calculated = await smithRoutingEditInputHash(original);
      } catch {
        return {
          state: "unknown",
          message: "The exact routing edit request could not be verified.",
        };
      }
      if (calculated !== proof.inputHash)
        return {
          state: "unknown",
          message: "The routing edit request differs from its saved identity.",
        };
      if (!deps.canWrite() || deps.scope() !== proof.scope)
        return verifiedNotSent(
          proof,
          "Workspace access changed before the routing edit was dispatched.",
        );
      try {
        const response = await deps.post(editPath, original, responseBytes);
        const raw: unknown = await response.json().catch(() => null);
        if (response.status === 403)
          return verifiedNotSent(
            proof,
            "Operator access refused this edit before its effect.",
          );
        const parsedEnvelope = envelope.safeParse(raw);
        const parsedReceipt = parsedEnvelope.success
          ? smithRoutingEditReceiptSchema.safeParse(parsedEnvelope.data.data)
          : null;
        if (
          parsedReceipt?.success &&
          response.status === expectedStatus[parsedReceipt.data.result.phase] &&
          parsedReceipt.data.requestId === original.requestId &&
          parsedReceipt.data.inputHash === proof.inputHash &&
          canonicalSmithRoutingEditRequest(parsedReceipt.data.original) ===
            canonicalSmithRoutingEditRequest(original)
        )
          return { state: "sent", value: raw };
        return {
          state: "unknown",
          message: "The server did not return a verified routing edit receipt.",
        };
      } catch (error) {
        return error instanceof NotSent
          ? verifiedNotSent(proof, error.message)
          : {
              state: "unknown",
              message: "The routing edit may have reached the server.",
            };
      }
    },
    async original(requestId: string): Promise<unknown> {
      const checkedId = smithRoutingEditRequestIdSchema.parse(requestId);
      const response = await deps.read(
        `${originalPath}/${encodeURIComponent(checkedId)}`,
        { method: "GET" },
        responseBytes,
      );
      if (response.status !== 200)
        throw Error("The saved routing edit original could not be verified.");
      return response.json() as Promise<unknown>;
    },
  };
}
