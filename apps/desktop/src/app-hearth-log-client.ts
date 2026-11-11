import {
  type HearthLogSnapshot,
  hearthLogSnapshotSchema,
} from "../../../scripts/desktop/app-hearth-log-protocol";

export interface HearthLogClientState {
  data: HearthLogSnapshot | null;
  fresh: boolean;
  busy: boolean;
  unsupported: boolean;
  previousGeneration: string | null;
  lifetimeChanged: boolean;
  filter: "all" | "warnings";
  error: string | null;
}
const UNAVAILABLE =
  "Hearth service logs could not be verified. Showing the last read snapshot, if any.";
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
/** Read-only owner; no action transport, raw console input or persisted request state. */
export function createHearthLogClient(deps: {
  read(): Promise<Response>;
  canRead(): boolean;
  changed(): void;
}) {
  const state: HearthLogClientState = {
    data: null,
    fresh: false,
    busy: false,
    unsupported: false,
    previousGeneration: null,
    lifetimeChanged: false,
    filter: "all",
    error: null,
  };
  let disposed = false;
  const changed = () => {
    if (!disposed) deps.changed();
  };
  function adopt(next: HearthLogSnapshot) {
    const previous = state.data;
    if (previous?.generation === next.generation) {
      if (
        next.startedAt !== previous.startedAt ||
        next.latestSequence < previous.latestSequence
      )
        throw Error(UNAVAILABLE);
      const oldRows = new Map(
        previous.entries.map((entry) => [entry.sequence, entry]),
      );
      for (const entry of next.entries) {
        const old = oldRows.get(entry.sequence);
        if (old && JSON.stringify(old) !== JSON.stringify(entry))
          throw Error(UNAVAILABLE);
      }
    } else if (previous) {
      state.previousGeneration = previous.generation;
      state.lifetimeChanged = true;
    }
    state.data = next;
    state.fresh = true;
    state.error = null;
    state.unsupported = false;
  }
  return {
    state,
    rows() {
      return (state.data?.entries ?? []).filter(
        (entry) => state.filter === "all" || entry.level === "warning",
      );
    },
    filter(value: string) {
      if (disposed || (value !== "all" && value !== "warnings")) return;
      state.filter = value;
      changed();
    },
    async check() {
      if (disposed || state.busy || !deps.canRead()) return;
      state.busy = true;
      state.fresh = false;
      state.error = null;
      state.unsupported = false;
      changed();
      try {
        const response = await deps.read();
        if (disposed) {
          try {
            await response.body?.cancel();
          } catch {
            /* Retired reads have no owner to update. */
          }
          return;
        }
        if (response.status === 404) {
          state.unsupported = true;
          try {
            await response.body?.cancel();
          } catch {}
          throw Error(UNAVAILABLE);
        }
        const raw: unknown = await response.json();
        if (disposed) return;
        if (!response.ok || !envelope(raw) || !raw.ok || raw.error !== null)
          throw Error(UNAVAILABLE);
        adopt(hearthLogSnapshotSchema.parse(raw.data));
      } catch {
        if (!disposed) {
          state.fresh = false;
          state.error = UNAVAILABLE;
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
