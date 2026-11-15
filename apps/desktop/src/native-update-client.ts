import { compareReleaseVersions } from "../../../scripts/desktop/release-version";
import {
  type NativeUpdateAuthorization,
  type NativeUpdatePending,
  type NativeUpdateRequest,
  type NativeUpdateResult,
  nativeUpdateAuthorizationResultSchema,
  nativeUpdateAuthorizationSchema,
  nativeUpdatePendingSchema,
  nativeUpdateResultSchema,
} from "../../../types/native-update";
export interface NativeUpdateDependencies {
  native(request: NativeUpdateRequest): Promise<unknown>;
  authorize(request: NativeUpdateAuthorization): Promise<unknown>;
  connected(): boolean;
  newId(): string;
  changed(): void;
  storage: { load(): unknown; save(value: NativeUpdatePending | null): void };
  currentVersion: string;
}
const unavailable =
  "The native update result could not be verified. Check the original outcome before trying another installation.";
function data(raw: unknown): unknown {
  if (
    !raw ||
    typeof raw !== "object" ||
    !("ok" in raw) ||
    raw.ok !== true ||
    !("error" in raw) ||
    raw.error !== null ||
    !("data" in raw) ||
    Object.keys(raw).sort().join(",") !== "data,error,ok"
  )
    throw Error(unavailable);
  return raw.data;
}
export function createNativeUpdateClient(deps: NativeUpdateDependencies) {
  const state: {
    busy: boolean;
    result: NativeUpdateResult | null;
    review: boolean;
    unknown: boolean;
    error: string | null;
  } = { busy: false, result: null, review: false, unknown: false, error: null };
  let disposed = false,
    pending: NativeUpdatePending | null = null;
  try {
    const saved = deps.storage.load();
    if (saved !== null) pending = nativeUpdatePendingSchema.parse(saved);
    state.unknown = pending !== null;
  } catch {
    state.unknown = true;
    state.error =
      "Saved installation intent is unavailable. Further installations remain held.";
  }
  const publish = () => {
    if (!disposed) deps.changed();
  };
  const live = () => !disposed && deps.connected();
  const accept = (raw: unknown, id: string | null) => {
    const result = nativeUpdateResultSchema.parse(data(raw));
    if (
      result.currentVersion !== deps.currentVersion ||
      (id !== null && result.requestId !== id) ||
      (pending &&
        (result.scopeKey !== pending.scopeKey ||
          (result.version !== null && result.version !== pending.version))) ||
      (state.result && result.scopeKey !== state.result.scopeKey)
    )
      throw Error(unavailable);
    state.result = result;
    if (result.state === "install-unknown") {
      state.unknown = true;
      if (!pending) {
        pending = nativeUpdatePendingSchema.parse({
          schemaVersion: 1,
          requestId: result.requestId,
          currentVersion: result.currentVersion,
          version: result.version,
          scopeKey: result.scopeKey,
        });
        deps.storage.save(pending);
        const observed = nativeUpdatePendingSchema.parse(deps.storage.load());
        if (JSON.stringify(pending) !== JSON.stringify(observed))
          throw Error(unavailable);
      }
    }
    return result;
  };
  const authorize = async (
    operation: NativeUpdateAuthorization["operation"],
    requestId: string,
  ) => {
    const request = nativeUpdateAuthorizationSchema.parse({
      operation,
      requestId,
    });
    const approved = nativeUpdateAuthorizationResultSchema.parse(
      data(await deps.authorize(request)),
    );
    if (
      approved.operation !== operation ||
      approved.requestId !== requestId ||
      !live()
    )
      throw Error(unavailable);
    return request;
  };
  const busy = async (run: () => Promise<void>) => {
    if (!live() || state.busy) return;
    state.busy = true;
    state.error = null;
    publish();
    try {
      await run();
    } catch {
      if (!disposed) state.error = unavailable;
    } finally {
      if (!disposed) {
        state.busy = false;
        publish();
      }
    }
  };
  return {
    state,
    async refresh() {
      await busy(async () => {
        const id = pending?.requestId ?? state.result?.requestId ?? null;
        if (state.unknown && !pending) throw Error(unavailable);
        const raw = await deps.native({ operation: "status", requestId: id });
        if (!live()) return;
        const result = accept(raw, id);
        if (
          pending &&
          (result.state === "not-attempted" ||
            result.state === "version-observed")
        ) {
          if (
            result.state === "version-observed" &&
            (compareReleaseVersions(result.currentVersion, pending.version) ??
              -1) < 0
          )
            throw Error(unavailable);
          deps.storage.save(null);
          if (deps.storage.load() !== null) throw Error(unavailable);
          pending = null;
          state.unknown = false;
        }
      });
    },
    async check() {
      if (state.unknown || state.result?.state === "unconfigured") return;
      await busy(async () => {
        state.review = false;
        const id = deps.newId();
        const request = await authorize("check", id);
        const raw = await deps.native(request);
        if (live()) accept(raw, id);
      });
    },
    async download() {
      const result = state.result;
      if (state.unknown || result?.state !== "available" || !result.requestId)
        return;
      await busy(async () => {
        state.review = false;
        const request = await authorize("download", result.requestId!);
        const raw = await deps.native(request);
        if (live()) accept(raw, result.requestId);
      });
    },
    review() {
      if (
        live() &&
        !state.busy &&
        !state.unknown &&
        state.result?.state === "downloaded"
      ) {
        state.review = true;
        state.error = null;
        publish();
      }
    },
    cancel() {
      if (!state.busy) {
        state.review = false;
        publish();
      }
    },
    async confirm() {
      const result = state.result;
      if (
        !state.review ||
        state.unknown ||
        result?.state !== "downloaded" ||
        !result.requestId ||
        !result.version
      )
        return;
      await busy(async () => {
        const intent = nativeUpdatePendingSchema.parse({
          schemaVersion: 1,
          requestId: result.requestId,
          currentVersion: result.currentVersion,
          version: result.version,
          scopeKey: result.scopeKey,
        });
        deps.storage.save(intent);
        const observed = nativeUpdatePendingSchema.parse(deps.storage.load());
        if (JSON.stringify(intent) !== JSON.stringify(observed))
          throw Error(unavailable);
        pending = intent;
        state.unknown = true;
        state.review = false;
        publish();
        const request = await authorize("install", intent.requestId);
        const raw = await deps.native(request);
        if (live()) accept(raw, intent.requestId);
      });
    },
    dispose() {
      disposed = true;
    },
  };
}
