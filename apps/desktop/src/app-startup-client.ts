import {
  type StartupRecord,
  type StartupRequest,
  type StartupStatus,
  startupRequestSchema,
  startupStatusSchema,
} from "../../../scripts/desktop/app-startup-protocol";
export const STARTUP_PENDING_KEY = "agent-forge-startup-pending-v1";
type SavedIntent = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface AppStartupState {
  data: StartupStatus | null;
  draft: boolean | null;
  pending: StartupRequest | null;
  busy: boolean;
  fresh: boolean;
  storageProblem: boolean;
  error: string | null;
  message: string;
}
const UNKNOWN =
  "Startup save outcome is unknown. Check registration; do not repeat the request.";
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
export function createAppStartupClient(deps: {
  storage: SavedIntent | null;
  requestId(): string;
  canAct(): boolean;
  changed(): void;
  read(): Promise<Response>;
  post(request: StartupRequest): Promise<Response>;
}) {
  const state: AppStartupState = {
    data: null,
    draft: null,
    pending: null,
    busy: false,
    fresh: false,
    storageProblem: false,
    error: null,
    message: "Startup registration has not been checked.",
  };
  let disposed = false;
  let latestRecord: StartupRecord | null = null;
  const publish = () => {
    if (!disposed) deps.changed();
  };
  function loadIntent() {
    try {
      if (!deps.storage) throw Error();
      const raw = deps.storage.getItem(STARTUP_PENDING_KEY);
      if (raw !== null) {
        if (raw.length > 1024) throw Error();
        state.pending = startupRequestSchema.parse(JSON.parse(raw));
        state.draft ??= state.pending.enabled;
      }
    } catch {
      state.storageProblem = true;
      throw Error(UNKNOWN);
    }
  }
  try {
    loadIntent();
  } catch {
    /* Unknown local evidence keeps writes held. */
  }
  function clearIntent() {
    if (
      !deps.storage ||
      deps.storage.getItem(STARTUP_PENDING_KEY) !==
        JSON.stringify(state.pending)
    )
      throw Error(UNKNOWN);
    deps.storage.removeItem(STARTUP_PENDING_KEY);
    state.pending = null;
  }
  const canEdit = () =>
    !disposed &&
    !state.busy &&
    !state.pending &&
    !state.storageProblem &&
    state.fresh &&
    state.data?.capability === "available" &&
    state.data.canSave &&
    deps.canAct();
  const canSave = () =>
    canEdit() &&
    state.draft !== null &&
    state.data?.capability === "available" &&
    state.draft !== (state.data.registration === "enabled");
  async function fetchStatus(): Promise<StartupStatus> {
    const response = await deps.read();
    if (response.status === 404) return { capability: "unsupported" };
    const raw: unknown = await response.json();
    if (!response.ok || !envelope(raw) || raw.ok !== true || raw.error !== null)
      throw Error();
    return startupStatusSchema.parse(raw.data);
  }
  function exact(data: StartupStatus) {
    if (data.capability !== "available" || !state.pending) return null;
    const last = data.record.last;
    return data.installationKey === state.pending.installationKey &&
      data.record.revision === state.pending.expectedRevision + 1 &&
      last &&
      JSON.stringify(last.request) === JSON.stringify(state.pending)
      ? last
      : null;
  }
  function adopt(data: StartupStatus) {
    if (data.capability === "available") {
      const record = data.record;
      if (
        latestRecord &&
        (record.revision < latestRecord.revision ||
          (record.revision === latestRecord.revision &&
            (JSON.stringify(record.last?.request) !==
              JSON.stringify(latestRecord.last?.request) ||
              record.last?.startedAt !== latestRecord.last?.startedAt ||
              (latestRecord.last?.state !== "pending" &&
                latestRecord.last?.state !== record.last?.state))))
      )
        throw Error("Inconsistent startup receipt history");
      latestRecord = structuredClone(record);
    }
    state.data = data;
    state.fresh = true;
    state.message = "Startup registration read.";
    const matched = exact(data);
    if (matched && matched.state !== "pending") {
      const desired = state.pending?.enabled;
      clearIntent();
      if (matched.state === "completed") {
        state.message =
          "Original startup save confirmed; current registration read.";
        if (
          data.capability === "available" &&
          (data.registration === "enabled") === desired &&
          data.registration !== "conflict"
        )
          state.draft = null;
      } else
        state.message =
          "Original startup request was refused; current registration read.";
    }
    if (state.pending) state.error = UNKNOWN;
  }
  return {
    state,
    canEdit,
    canSave,
    edit(enabled: boolean) {
      if (!canEdit() || typeof enabled !== "boolean") return;
      state.draft = enabled;
      publish();
    },
    discard() {
      if (disposed || state.busy || state.pending) return;
      state.draft = null;
      publish();
    },
    async check() {
      if (disposed || state.busy || !deps.canAct()) return;
      state.busy = true;
      state.fresh = false;
      state.error = null;
      publish();
      try {
        const data = await fetchStatus();
        if (!disposed) adopt(data);
      } catch {
        if (!disposed) {
          state.fresh = false;
          state.error = state.pending
            ? UNKNOWN
            : "Startup registration could not be verified. Showing last read values, if any.";
        }
      } finally {
        if (!disposed) {
          state.busy = false;
          publish();
        }
      }
    },
    async save() {
      if (
        !canSave() ||
        state.data?.capability !== "available" ||
        state.draft === null ||
        state.data.fingerprint === null
      )
        return;
      const snapshot = state.data,
        enabled = state.draft;
      state.busy = true;
      state.fresh = false;
      state.error = null;
      publish();
      try {
        loadIntent();
        if (state.pending) throw Error(UNKNOWN);
        const request = startupRequestSchema.parse({
          requestId: deps.requestId(),
          installationKey: snapshot.installationKey,
          expectedRevision: snapshot.record.revision,
          expectedFingerprint: snapshot.fingerprint,
          enabled,
        });
        state.pending = request;
        try {
          if (!deps.storage) throw Error();
          deps.storage.setItem(STARTUP_PENDING_KEY, JSON.stringify(request));
          if (
            deps.storage.getItem(STARTUP_PENDING_KEY) !==
            JSON.stringify(request)
          )
            throw Error();
        } catch {
          state.storageProblem = true;
          throw Error(UNKNOWN);
        }
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
          state.message =
            "Startup request refused. No registration change was made by this request. Check current registration before saving again.";
          return;
        }
        if (
          !response.ok ||
          !envelope(raw) ||
          raw.ok !== true ||
          raw.error !== null
        )
          throw Error(UNKNOWN);
        const data = startupStatusSchema.parse(raw.data),
          receipt = exact(data);
        if (
          data.capability !== "available" ||
          receipt?.state !== "completed" ||
          data.registration !== (enabled ? "enabled" : "disabled")
        )
          throw Error(UNKNOWN);
        clearIntent();
        adopt(data);
        state.draft = null;
        state.message = "Startup registration save confirmed.";
        // Confirmed write is followed by an independent read; a failed refresh holds further saves.
        try {
          const fresh = await fetchStatus();
          if (!disposed) adopt(fresh);
        } catch {
          if (!disposed) {
            state.fresh = false;
            state.error =
              "The save was confirmed, but current registration could not be refreshed. Showing the confirmed receipt.";
          }
        }
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
