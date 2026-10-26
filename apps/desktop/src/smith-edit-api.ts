import { z } from "zod";
import {
  NotSent,
  type operatorPost,
  type operatorRead,
} from "../../../docs/js/operator";
import {
  canonicalSmithConfigEditRequest,
  smithConfigEditReceiptSchema,
  smithConfigEditRequestSchema,
} from "../../../scripts/config/smith-edit-protocol";
import type {
  SmithConfigEditPreviewRequest,
  SmithConfigEditRequest,
} from "../../../types/smith-config-edit";
import { smithConfigEditInputHash } from "./smith-edit-identities";

const verifiedNotSentToken = Symbol("verified Smith edit NotSent");
interface VerifiedSmithEditNotSent {
  readonly state: "not-sent";
  readonly requestId: string;
  readonly scope: string;
  readonly inputHash: string;
  readonly message: string;
  readonly [verifiedNotSentToken]: true;
}
export type SmithEditPostResult =
  | VerifiedSmithEditNotSent
  | { state: "sent"; value: unknown }
  | { state: "unknown"; message: string };

export function isVerifiedSmithEditNotSent(
  value: SmithEditPostResult,
  expected: { requestId: string; scope: string; inputHash: string },
): value is VerifiedSmithEditNotSent {
  return (
    value.state === "not-sent" &&
    value.requestId === expected.requestId &&
    value.scope === expected.scope &&
    value.inputHash === expected.inputHash &&
    value[verifiedNotSentToken] === true
  );
}

const verifiedNotSent = (
  identity: { requestId: string; scope: string; inputHash: string },
  message: string,
): VerifiedSmithEditNotSent => ({
  state: "not-sent",
  ...identity,
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
  scope(): string;
  canWrite(): boolean;
}) {
  return {
    async preview(input: SmithConfigEditPreviewRequest): Promise<unknown> {
      const response = await deps.post(previewPath, input, responseBytes);
      if (response.status !== 200)
        throw Error("The Smith edit preview could not be verified.");
      return response.json() as Promise<unknown>;
    },
    async edit(
      request: SmithConfigEditRequest,
      reserved: { scope: string; inputHash: string },
    ): Promise<SmithEditPostResult> {
      let original: SmithConfigEditRequest;
      try {
        original = smithConfigEditRequestSchema.parse(structuredClone(request));
      } catch {
        return {
          state: "unknown",
          message: "The exact Smith edit request could not be verified.",
        };
      }
      const proofIdentity = {
        requestId: original.requestId,
        scope: reserved.scope,
        inputHash: reserved.inputHash,
      };
      if (
        !/^[a-f0-9]{64}$/.test(reserved.inputHash) ||
        reserved.scope.length < 1 ||
        reserved.scope.length > 512
      )
        return {
          state: "unknown",
          message: "The Smith edit reservation could not be verified.",
        };
      const startingScope = deps.scope();
      let canonicalHash: string;
      try {
        canonicalHash = await smithConfigEditInputHash(original);
      } catch {
        return {
          state: "unknown",
          message: "The exact Smith edit request could not be verified.",
        };
      }
      if (canonicalHash !== reserved.inputHash)
        return {
          state: "unknown",
          message: "The Smith edit request differs from its saved identity.",
        };
      if (
        !deps.canWrite() ||
        startingScope !== reserved.scope ||
        deps.scope() !== startingScope
      )
        return verifiedNotSent(
          proofIdentity,
          "Workspace access changed before the edit request was dispatched.",
        );
      try {
        const response = await deps.post(editPath, original, responseBytes);
        const raw: unknown = await response.json().catch(() => null);
        if (response.status === 403)
          return verifiedNotSent(
            proofIdentity,
            "Operator access refused this edit before its effect.",
          );
        const parsedEnvelope = envelope.safeParse(raw);
        const parsedReceipt = parsedEnvelope.success
          ? smithConfigEditReceiptSchema.safeParse(parsedEnvelope.data.data)
          : null;
        if (
          parsedReceipt?.success &&
          response.status === expectedStatus[parsedReceipt.data.result.phase] &&
          parsedReceipt.data.requestId === original.requestId &&
          canonicalSmithConfigEditRequest(parsedReceipt.data.original) ===
            canonicalSmithConfigEditRequest(original)
        )
          return { state: "sent", value: raw };
        return {
          state: "unknown",
          message: "The server did not return a verified Smith edit receipt.",
        };
      } catch (error) {
        return error instanceof NotSent
          ? verifiedNotSent(proofIdentity, error.message)
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
