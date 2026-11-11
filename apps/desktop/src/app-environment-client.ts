import {
  ENVIRONMENT_LIMITS,
  type EnvironmentRecord,
  type EnvironmentRequest,
  type EnvironmentStatus,
  environmentNamesSchema,
  environmentRequestSchema,
  environmentStatusSchema,
} from "../../../scripts/config/environment-protocol";

export const ENVIRONMENT_PENDING_KEY = "agent-forge-environment-pending-v1";
type PendingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Review = Omit<EnvironmentRequest, "requestId">;
export interface EnvironmentSettingsClientState {
  data: EnvironmentStatus | null;
  fresh: boolean;
  busy: boolean;
  unsupported: boolean;
  draft: string;
  draftOwner: string | null;
  reviewed: Review | null;
  pending: EnvironmentRequest | null;
  confirmed: { requestId: string; finishedAt: string; names: string[] } | null;
  storageProblem: boolean;
  error: string | null;
}
const UNKNOWN =
  "The environment save outcome is unknown. Check its exact receipt; do not repeat the request.";
const UNAVAILABLE =
  "Environment settings could not be verified. Showing last read values, if any.";
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);
function namesFrom(text: string) {
  return environmentNamesSchema.safeParse(
    text
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean),
  );
}
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
export function createEnvironmentSettingsClient(deps: {
  storage: PendingStorage | null;
  requestId(): string;
  read(): Promise<Response>;
  post(request: EnvironmentRequest): Promise<Response>;
  canAct(): boolean;
  changed(): void;
}) {
  const state: EnvironmentSettingsClientState = {
    data: null,
    fresh: false,
    busy: false,
    unsupported: false,
    draft: "",
    draftOwner: null,
    reviewed: null,
    pending: null,
    confirmed: null,
    storageProblem: false,
    error: null,
  };
  let disposed = false,
    latest: EnvironmentRecord | null = null;
  const changed = () => {
    if (!disposed) deps.changed();
  };
  function readIntent() {
    if (!deps.storage) throw Error("Private window storage unavailable");
    const text = deps.storage.getItem(ENVIRONMENT_PENDING_KEY);
    if (text === null) return null;
    if (
      new TextEncoder().encode(text).byteLength >
      ENVIRONMENT_LIMITS.requestBytes
    )
      throw Error("Invalid preserved intent");
    return environmentRequestSchema.parse(JSON.parse(text));
  }
  try {
    state.pending = readIntent();
    if (state.pending) {
      state.draft = state.pending.names.join("\n");
      state.draftOwner = state.pending.ownerKey;
    }
  } catch {
    state.storageProblem = true;
  }
  function clearIntent() {
    if (!deps.storage || !same(readIntent(), state.pending))
      throw Error("Preserved intent changed");
    deps.storage.removeItem(ENVIRONMENT_PENDING_KEY);
    if (deps.storage.getItem(ENVIRONMENT_PENDING_KEY) !== null)
      throw Error("Intent removal unavailable");
    state.pending = null;
  }
  function confirms(data: EnvironmentStatus, request: EnvironmentRequest) {
    return (
      data.record.revision === request.expectedJournalRevision + 1 &&
      data.record.last?.state === "completed" &&
      same(data.record.last.request, request)
    );
  }
  function adopt(data: EnvironmentStatus) {
    const previous = latest?.last,
      next = data.record.last;
    const completedPending =
      previous?.state === "pending" &&
      next !== null &&
      next.state !== "pending" &&
      same(previous.request, next.request) &&
      previous.candidateHash === next.candidateHash &&
      previous.startedAt === next.startedAt;
    if (
      latest &&
      (data.record.revision < latest.revision ||
        (data.record.revision === latest.revision &&
          !same(data.record, latest) &&
          !completedPending))
    )
      throw Error(UNAVAILABLE);
    latest = data.record;
    if (state.pending && confirms(data, state.pending)) {
      const last = data.record.last!;
      if (!last.finishedAt) throw Error(UNKNOWN);
      state.confirmed = {
        requestId: last.request.requestId,
        finishedAt: last.finishedAt,
        names: [...last.request.names],
      };
      try {
        clearIntent();
      } catch {
        state.storageProblem = true;
        throw Error(UNKNOWN);
      }
    }
    if (state.draftOwner === null) {
      state.draft = data.names.join("\n");
      state.draftOwner = data.ownerKey;
    }
    state.data = data;
    state.unsupported = false;
    state.fresh = true;
    state.reviewed = null;
    state.error = state.pending ? UNKNOWN : null;
  }
  function editable() {
    return (
      !disposed &&
      !state.busy &&
      !state.pending &&
      !state.storageProblem &&
      state.fresh &&
      state.data?.canSave === true &&
      state.draftOwner === state.data.ownerKey &&
      deps.canAct()
    );
  }
  function canReview() {
    const parsed = namesFrom(state.draft);
    return (
      editable() && parsed.success && !same(parsed.data, state.data?.names)
    );
  }
  const canSave = () => canReview() && state.reviewed !== null;
  async function checkedRead() {
    const response = await deps.read();
    if (disposed) return;
    if (response.status === 404) {
      state.unsupported = true;
      throw Error(UNAVAILABLE);
    }
    const raw: unknown = await response.json();
    if (disposed) return;
    if (!response.ok || !envelope(raw) || !raw.ok || raw.error !== null)
      throw Error(UNAVAILABLE);
    adopt(environmentStatusSchema.parse(raw.data));
  }
  return {
    state,
    canReview,
    canSave,
    validationError() {
      return namesFrom(state.draft).success
        ? null
        : "Use at most256 unique names, one per line, with letters, digits and underscores. Values are not accepted.";
    },
    edit(text: string) {
      if (
        disposed ||
        state.busy ||
        state.pending ||
        state.storageProblem ||
        !state.data ||
        !state.fresh ||
        !deps.canAct()
      )
        return;
      state.draft = text;
      state.draftOwner = state.data.ownerKey;
      state.reviewed = null;
      changed();
    },
    cancel() {
      if (disposed || state.busy || state.pending || !state.data) return;
      state.draft = state.data.names.join("\n");
      state.draftOwner = state.data.ownerKey;
      state.reviewed = null;
      state.error = null;
      changed();
    },
    review() {
      if (!canReview() || !state.data) return;
      const parsed = namesFrom(state.draft);
      if (!parsed.success) return;
      state.reviewed = {
        ownerKey: state.data.ownerKey,
        expectedRevision: { ...state.data.revision },
        expectedJournalRevision: state.data.record.revision,
        names: [...parsed.data],
      };
      changed();
    },
    async check() {
      if (disposed || state.busy || !deps.canAct()) return;
      state.busy = true;
      state.fresh = false;
      state.reviewed = null;
      changed();
      try {
        await checkedRead();
      } catch {
        if (!disposed) {
          state.fresh = false;
          state.error = state.pending ? UNKNOWN : UNAVAILABLE;
        }
      } finally {
        if (!disposed) {
          state.busy = false;
          changed();
        }
      }
    },
    async save() {
      if (!canSave() || !state.reviewed) return;
      const review = state.reviewed;
      state.busy = true;
      state.fresh = false;
      state.reviewed = null;
      state.error = null;
      let sent = false;
      try {
        const existing = readIntent();
        if (existing) {
          state.pending = existing;
          throw Error(UNKNOWN);
        }
        const request = environmentRequestSchema.parse({
          requestId: deps.requestId(),
          ...review,
        });
        if (!deps.storage) throw Error("Storage unavailable");
        deps.storage.setItem(ENVIRONMENT_PENDING_KEY, JSON.stringify(request));
        state.pending = request;
        if (!same(readIntent(), request))
          throw Error("Preserved intent mismatch");
        changed();
        sent = true;
        const response = await deps.post(request),
          raw: unknown = await response.json();
        if (disposed) return;
        if (!envelope(raw)) throw Error(UNKNOWN);
        if (!response.ok || !raw.ok || raw.error !== null) {
          if (
            [400, 403, 409, 503].includes(response.status) &&
            raw.ok === false &&
            raw.data === null &&
            typeof raw.error === "string"
          ) {
            clearIntent();
            state.error =
              "The save was refused before publication. Check settings and review the draft again.";
            return;
          }
          throw Error(UNKNOWN);
        }
        const data = environmentStatusSchema.parse(raw.data);
        if (!confirms(data, request)) throw Error(UNKNOWN);
        adopt(data);
        // A terminal receipt describes the publication then; a separate read supplies current configuration.
        state.fresh = false;
        await checkedRead();
      } catch {
        if (!disposed) {
          state.fresh = false;
          if (!sent) state.storageProblem = true;
          state.error = state.pending ? UNKNOWN : UNAVAILABLE;
        }
      } finally {
        if (!disposed) {
          state.busy = false;
          changed();
        }
      }
    },
    dispose() {
      disposed = true;
    },
  };
}
