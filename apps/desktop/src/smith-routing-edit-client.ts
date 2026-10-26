import type {
  SmithRoutingEditChange,
  SmithRoutingEditPreview,
  SmithRoutingEditPreviewRequest,
  SmithRoutingEditRequest,
  SmithRoutingEditTarget,
} from "../../../types/smith-routing-edit";

export type SmithRoutingEditIdentity = {
  requestId: string;
  scope: string;
  target: SmithRoutingEditTarget;
  selector: string;
  inputHash: string;
  retired: boolean;
  retirement?: "verified-not-sent" | "confirmed" | "refused";
};
export type SmithRoutingEditIdentityStore = {
  list(): SmithRoutingEditIdentity[];
  reserve(
    value: SmithRoutingEditIdentity,
  ): Promise<{ identity: SmithRoutingEditIdentity; created: boolean }>;
  retire(
    expected: SmithRoutingEditIdentity,
    reason: NonNullable<SmithRoutingEditIdentity["retirement"]>,
  ): Promise<SmithRoutingEditIdentity>;
};
export type SmithRoutingEditPostResult =
  | { state: "sent"; value: unknown }
  | {
      state: "not-sent";
      requestId: string;
      scope: string;
      inputHash: string;
      message: string;
    }
  | { state: "unknown"; message: string };

/** First-checkpoint seam; the state machine follows the reviewed RED tests. */
export function createSmithRoutingEditClient(_deps: {
  identities(scope: string): SmithRoutingEditIdentityStore;
  scope(): string;
  canWrite(): boolean;
  requestId(): string;
  preview(input: SmithRoutingEditPreviewRequest): Promise<unknown>;
  post(
    request: SmithRoutingEditRequest,
    reservation: { scope: string; inputHash: string },
  ): Promise<SmithRoutingEditPostResult>;
  readOriginal(requestId: string): Promise<unknown>;
}) {
  const state = {
    target: "workspace" as const,
    change: null as SmithRoutingEditChange | null,
    preview: null as SmithRoutingEditPreview | null,
    previewStale: false,
    entries: [] as {
      identity: SmithRoutingEditIdentity;
      state: "held" | "confirmed" | "refused" | "not-sent";
    }[],
    notice: "",
  };
  return {
    get: () => structuredClone(state),
    setDraft: (
      _target: SmithRoutingEditTarget,
      _change: SmithRoutingEditChange,
    ) => {},
    preview: async () => {},
    save: async () => {},
    check: async (_id: string) => {},
    recover: async () => {},
    dispose: () => {},
  };
}
