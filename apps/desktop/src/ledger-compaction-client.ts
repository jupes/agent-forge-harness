import {
  type LedgerCompactionRequest,
  type LedgerCompactionStatus,
  ledgerCompactionRequestSchema,
  ledgerCompactionStatusSchema,
} from "../../../scripts/desktop/ledger-compaction-protocol";

export const COMPACTION_PENDING_KEY =
  "agent-forge-ledger-compaction-pending-v1";
type PendingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface LedgerCompactionClientState {
  data: LedgerCompactionStatus | null;
  fresh: boolean;
  busy: boolean;
  acknowledged: boolean;
  pending: LedgerCompactionRequest | null;
  storageProblem: boolean;
  error: string | null;
}
const UNKNOWN =
  "Compaction outcome is unknown. Check status; do not repeat the request.";
const UNAVAILABLE =
  "Compaction status could not be verified. Showing last read values, if any.";
function envelope(
  raw: unknown,
): raw is { ok: boolean; data: unknown; error: unknown } {
  return (
    !!raw &&
    typeof raw === "object" &&
    "ok" in raw &&
    typeof raw.ok === "boolean" &&
    "data" in raw &&
    "error" in raw
  );
}
/** Explicit actions only; a preserved intent is reconciled only with its exact completed receipt. */
export function createLedgerCompactionClient(deps: {
  storage: PendingStorage | null;
  requestId(): string;
  read(): Promise<Response>;
  post(request: LedgerCompactionRequest): Promise<Response>;
  canAct(): boolean;
  changed(): void;
}) {
  const state: LedgerCompactionClientState = {
    data: null,
    fresh: false,
    busy: false,
    acknowledged: false,
    pending: null,
    storageProblem: false,
    error: null,
  };
  let disposed = false;
  function loadIntent() {
    try {
      if (!deps.storage) throw Error("Storage unavailable");
      const text = deps.storage.getItem(COMPACTION_PENDING_KEY);
      if (text !== null) {
        if (text.length > 1024) throw Error("Invalid intent");
        state.pending = ledgerCompactionRequestSchema.parse(JSON.parse(text));
      }
    } catch (error) {
      state.storageProblem = true;
      throw error;
    }
  }
  try {
    loadIntent();
  } catch {
    state.storageProblem = true;
  }
  function clearIntent() {
    if (
      !deps.storage ||
      deps.storage.getItem(COMPACTION_PENDING_KEY) !==
        JSON.stringify(state.pending)
    )
      throw Error("Intent changed");
    deps.storage.removeItem(COMPACTION_PENDING_KEY);
    state.pending = null;
  }
  const publish = () => {
    if (!disposed) deps.changed();
  };
  const canCompact = () =>
    !disposed &&
    !state.busy &&
    !state.pending &&
    !state.storageProblem &&
    state.fresh &&
    state.data?.canCompact === true &&
    deps.canAct();
  function confirms(data: LedgerCompactionStatus) {
    const pending = state.pending;
    return (
      !!pending &&
      data.record.ledgerKey === pending.expectedLedgerKey &&
      data.record.revision === pending.expectedRevision + 1 &&
      data.record.last?.requestId === pending.requestId &&
      data.record.last.state === "completed"
    );
  }
  return {
    state,
    canCompact,
    acknowledge(value: boolean) {
      state.acknowledged = canCompact() && value;
      publish();
    },
    async check() {
      if (disposed || state.busy || !deps.canAct()) return;
      state.busy = true;
      state.acknowledged = false;
      state.fresh = false;
      state.error = null;
      publish();
      try {
        const response = await deps.read(),
          raw: unknown = await response.json();
        if (disposed) return;
        if (
          !response.ok ||
          !envelope(raw) ||
          raw.ok !== true ||
          raw.error !== null
        )
          throw Error(UNAVAILABLE);
        const data = ledgerCompactionStatusSchema.parse(raw.data);
        state.data = data;
        state.fresh = true;
        if (state.pending && confirms(data)) clearIntent();
        if (state.pending) state.error = UNKNOWN;
      } catch {
        if (!disposed) {
          state.fresh = false;
          state.error = state.pending ? UNKNOWN : UNAVAILABLE;
        }
      } finally {
        if (!disposed) {
          state.busy = false;
          publish();
        }
      }
    },
    async compact() {
      if (!canCompact() || !state.acknowledged || !state.data) return;
      state.acknowledged = false;
      state.busy = true;
      state.fresh = false;
      state.error = null;
      try {
        // Check preserved intent again before spending a fresh acknowledgement.
        loadIntent();
        if (state.pending) throw Error(UNKNOWN);
        const request = ledgerCompactionRequestSchema.parse({
          requestId: deps.requestId(),
          expectedLedgerKey: state.data.record.ledgerKey,
          expectedRevision: state.data.record.revision,
          acknowledge90Days: true,
        });
        state.pending = request;
        try {
          if (!deps.storage) throw Error("Storage unavailable");
          deps.storage.setItem(COMPACTION_PENDING_KEY, JSON.stringify(request));
          if (
            deps.storage.getItem(COMPACTION_PENDING_KEY) !==
            JSON.stringify(request)
          )
            throw Error("Intent not preserved");
        } catch {
          state.storageProblem = true;
          throw Error(UNKNOWN);
        }
        publish();
        const response = await deps.post(request),
          raw: unknown = await response.json();
        if (disposed) return;
        if (
          envelope(raw) &&
          raw.ok === false &&
          raw.data === null &&
          typeof raw.error === "string" &&
          [400, 403, 409, 503].includes(response.status)
        ) {
          clearIntent();
          state.error =
            "Request refused. No upkeep was started by this request. Check status before reviewing a new acknowledgement.";
          return;
        }
        if (
          !response.ok ||
          !envelope(raw) ||
          raw.ok !== true ||
          raw.error !== null
        )
          throw Error(UNKNOWN);
        const data = ledgerCompactionStatusSchema.parse(raw.data);
        if (!confirms(data)) throw Error(UNKNOWN);
        clearIntent();
        state.data = data;
        state.fresh = true;
      } catch {
        if (!disposed) state.error = UNKNOWN;
      } finally {
        if (!disposed) {
          state.busy = false;
          publish();
        }
      }
    },
    dispose() {
      disposed = true;
    },
  };
}
