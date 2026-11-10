import { actionOutcome } from "../../../docs/js/action-outcome";
import {
  type AppAppearance,
  type AppAppearanceSettings,
  appAppearanceSchema,
  appAppearanceSettingsSchema,
  sameAppearance,
} from "../../../scripts/projects/app-appearance-protocol";

/** One owner for Settings, palette and periodic cross-window readback. */
export function createAppAppearanceClient(deps: {
  read(): Promise<unknown>;
  post(body: unknown): Promise<Response>;
  canWrite(): boolean;
  changed(): void;
}) {
  const state: {
    current: AppAppearanceSettings | null;
    draft: AppAppearance | null;
    busy: boolean;
    verified: boolean;
    unknownRevision: number | null;
    message: string;
  } = {
    current: null,
    draft: null,
    busy: false,
    verified: false,
    unknownRevision: null,
    message:
      "Appearance settings have not been checked. Using the dark compact default.",
  };
  let disposed = false;
  const publish = () => {
    if (!disposed) deps.changed();
  };
  const adopt = (raw: unknown) => {
    const fresh = appAppearanceSettingsSchema.parse(raw);
    if (
      state.current &&
      (fresh.revision < state.current.revision ||
        (fresh.revision === state.current.revision &&
          !sameAppearance(fresh.appearance, state.current.appearance)))
    )
      throw Error("Inconsistent appearance revision");
    state.current = fresh;
    state.verified = true;
    if (
      state.unknownRevision !== null &&
      fresh.revision <= state.unknownRevision
    ) {
      state.message =
        "The earlier save is still unknown. Further saves are held until a newer revision fences it.";
    } else {
      state.unknownRevision = null;
      state.message = `Appearance read at revision ${fresh.revision}. ${state.draft ? "Your draft is retained; compare it with the saved values." : "Saved appearance is active."}`;
    }
    return fresh;
  };
  const check = async () => {
    if (disposed || state.busy) return;
    state.busy = true;
    publish();
    try {
      const raw = await deps.read();
      if (!disposed) adopt(raw);
    } catch {
      if (!disposed) {
        state.verified = false;
        state.message =
          "Appearance could not be verified. Using the last read appearance; saves are held. Check again to recover.";
      }
    } finally {
      state.busy = false;
      publish();
    }
  };
  const canSave = () =>
    !disposed &&
    !state.busy &&
    state.verified &&
    deps.canWrite() &&
    !!state.current &&
    !!state.draft &&
    state.unknownRevision === null;
  const canToggle = () =>
    !disposed &&
    !state.busy &&
    state.verified &&
    deps.canWrite() &&
    !!state.current &&
    !state.draft &&
    state.unknownRevision === null;
  const client = {
    state,
    check,
    canSave,
    canToggle,
    dispose() {
      disposed = true;
    },
    edit(appearance: AppAppearance) {
      if (disposed || state.busy || state.unknownRevision !== null) return;
      state.draft = { ...appearance };
      publish();
    },
    discard() {
      if (disposed || state.busy || state.unknownRevision !== null) return;
      state.draft = null;
      publish();
    },
    async save() {
      if (!canSave()) return;
      const parsed = appAppearanceSchema.safeParse(state.draft);
      if (!parsed.success || !state.current) return;
      const expectedRevision = state.current.revision,
        appearance = parsed.data;
      state.busy = true;
      publish();
      const result = await actionOutcome(
        () => deps.post({ expectedRevision, appearance }),
        "Check saved appearance before trying another save.",
      );
      if (disposed) return;
      if (result.state === "refused") {
        state.verified = false;
        state.message =
          result.message + " Check current appearance before saving again.";
      } else if (result.state === "unknown") {
        state.unknownRevision = expectedRevision;
        state.message = result.message;
      } else {
        const receipt = appAppearanceSettingsSchema.safeParse(result.data);
        state.unknownRevision = expectedRevision;
        if (
          !receipt.success ||
          receipt.data.source !== "machine" ||
          receipt.data.revision !== expectedRevision + 1 ||
          !sameAppearance(receipt.data.appearance, appearance)
        ) {
          state.message =
            "The save receipt could not be verified. Check saved appearance; no retry was sent.";
        } else {
          try {
            const raw = await deps.read();
            if (disposed) return;
            const fresh = adopt(raw);
            if (
              fresh.revision === receipt.data.revision &&
              sameAppearance(fresh.appearance, appearance)
            ) {
              state.draft = null;
              state.message = `Appearance saved and read back at revision ${fresh.revision}.`;
            }
          } catch {
            state.verified = false;
            state.message =
              "Save receipt received, but readback could not be verified. Check saved appearance; your draft is retained.";
          }
        }
      }
      state.busy = false;
      publish();
    },
    async toggleTheme() {
      if (!canToggle() || !state.current) return;
      const current = state.current.appearance;
      client.edit({
        ...current,
        theme:
          current.theme === "dark"
            ? "light"
            : current.theme === "light"
              ? "system"
              : "dark",
      });
      await client.save();
    },
  };
  return client;
}
