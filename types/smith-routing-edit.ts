import type { BenchEntry } from "../scripts/config/defaults";
import type { BenchName } from "./hearth";

export type SmithRoutingEditTarget = "user" | "workspace";

export type SmithRoutingEditChange =
  | { kind: "default"; smith: string }
  | { kind: "bench"; bench: BenchName; entries: BenchEntry[] };

export interface SmithRoutingEditPreviewRequest {
  target: SmithRoutingEditTarget;
  change: SmithRoutingEditChange;
}

export interface SmithRoutingEditRevision {
  version: 1;
  user: string;
  workspace: string;
}

export interface SmithRoutingEditRequest
  extends SmithRoutingEditPreviewRequest {
  requestId: string;
  expectedRevision: SmithRoutingEditRevision;
}

export interface SmithRoutingEditReview {
  change: SmithRoutingEditChange;
  targetBefore: string | BenchEntry[] | null;
  targetAfter: string | BenchEntry[];
  effectiveBefore: string | BenchEntry[];
  effectiveAfter: string | BenchEntry[];
  provenanceBefore: string;
  provenanceAfter: string;
}

export interface SmithRoutingEditPreview {
  version: 1;
  target: SmithRoutingEditTarget;
  file: string;
  expectedRevision: SmithRoutingEditRevision;
  candidate: { sha256: string; byteLength: number; created: boolean };
  review: SmithRoutingEditReview;
}
