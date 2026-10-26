import type { Smith } from "./hearth";

export type SmithConfigTarget = "user" | "workspace";

/** Opaque hashes of both complete server-derived file revisions, including absence. */
export interface SmithConfigRevision {
  version: 1;
  user: string;
  workspace: string;
}

export interface SmithConfigPreviewRequest {
  target: SmithConfigTarget;
  smith: Smith;
}

export interface SmithConfigCreateRequest extends SmithConfigPreviewRequest {
  requestId: string;
  expectedRevision: SmithConfigRevision;
}

/** Only the new Smith is projected; the complete config and raw TOML stay private. */
export interface SmithConfigReview {
  before: null;
  after: Smith;
  provenance: Record<
    "provider" | "model" | "effort" | "enabled" | "tags",
    string
  >;
}

export interface SmithConfigPreview {
  version: 1;
  target: SmithConfigTarget;
  /** Server-derived physical target, for review; never a request path selector. */
  file: string;
  expectedRevision: SmithConfigRevision;
  candidate: { sha256: string; byteLength: number; created: boolean };
  review: SmithConfigReview;
}

export type SmithConfigCreateRefusal =
  | "stale-revision"
  | "invalid-candidate"
  | "source-unavailable"
  | "cancelled-before-attempt"
  | "write-refused-before-attempt";

export type SmithConfigCreateResult =
  | {
      phase: "held";
      /** Historical saved stage, never evidence that a producer is currently live. */
      stage: "intent" | "prepared" | "attempted" | "unconfirmed";
      preview: SmithConfigPreview | null;
    }
  | {
      phase: "confirmed";
      completedAt: string;
      preview: SmithConfigPreview;
      publication: { file: string; created: boolean; sha256: string };
    }
  | {
      phase: "refused";
      refusedAt: string;
      reason: SmithConfigCreateRefusal;
      preview: SmithConfigPreview | null;
    };

/** Protected historical original/result, never permission to publish or replay. */
export interface SmithConfigCreateReceipt {
  version: 1;
  requestId: string;
  ownerScopeHash: string;
  inputHash: string;
  createdAt: string;
  original: SmithConfigCreateRequest;
  result: SmithConfigCreateResult;
}
