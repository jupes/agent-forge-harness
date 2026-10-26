import type { Smith } from "./hearth";

export type SmithConfigEditTarget = "user" | "workspace";

/** Opaque hashes of the full server-derived user/workspace revisions. */
export interface SmithConfigEditRevision {
  version: 1;
  user: string;
  workspace: string;
}

export interface SmithConfigEditPreviewRequest {
  target: SmithConfigEditTarget;
  /** Immutable selected existing Smith name; must equal smith.name. */
  name: string;
  smith: Smith;
}

export interface SmithConfigEditRequest extends SmithConfigEditPreviewRequest {
  requestId: string;
  expectedRevision: SmithConfigEditRevision;
}

export interface SmithConfigEditFields {
  provider: string;
  model: string;
  effort: string;
  enabled: boolean;
  tags: string[];
}
export interface SmithConfigEditTargetBefore {
  provider?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  enabled?: boolean | undefined;
  tags?: string[] | undefined;
}

export interface SmithConfigEditReview {
  name: string;
  /** Supported fields physically present in the chosen layer before editing. */
  targetBefore: SmithConfigEditTargetBefore | null;
  /** Complete target-layer value that the one candidate will write. */
  targetAfter: Smith;
  effectiveBefore: Smith;
  effectiveAfter: Smith;
  provenanceBefore: Record<keyof SmithConfigEditFields, string>;
  provenanceAfter: Record<keyof SmithConfigEditFields, string>;
}

export interface SmithConfigEditPreview {
  version: 1;
  target: SmithConfigEditTarget;
  /** Server-derived physical target; never supplied by the request. */
  file: string;
  expectedRevision: SmithConfigEditRevision;
  candidate: { sha256: string; byteLength: number; created: boolean };
  review: SmithConfigEditReview;
}
