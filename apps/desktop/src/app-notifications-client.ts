import { actionOutcome } from "../../../docs/js/action-outcome";
import {
  type AppNotificationPolicy,
  type AppNotificationSettings,
  appInterruptionAllowed,
  appNotificationPolicySchema,
  appNotificationSettingsSchema,
} from "../../../scripts/projects/app-notifications-protocol";
import type { HaltNotification } from "./notification-delivery";
export function createAppNotificationClient(deps: {
  read(): Promise<unknown>;
  post(body: unknown): Promise<Response>;
  canWrite(): boolean;
  changed(): void;
}) {
  const state: {
    current: AppNotificationSettings | null;
    draft: AppNotificationPolicy | null;
    busy: boolean;
    unknownRevision: number | null;
    message: string;
  } = {
    current: null,
    draft: null,
    busy: false,
    unknownRevision: null,
    message: "App notification settings have not been checked.",
  };
  let epoch = 0;
  const publish = () => deps.changed();
  const check = async () => {
    if (state.busy) return;
    state.busy = true;
    const turn = ++epoch;
    publish();
    try {
      const fresh = appNotificationSettingsSchema.parse(await deps.read());
      if (turn !== epoch) return;
      if (state.current && fresh.revision < state.current.revision)
        throw Error("Older app settings revision.");
      state.current = fresh;
      if (
        state.unknownRevision !== null &&
        fresh.revision <= state.unknownRevision
      )
        state.message =
          "The earlier save outcome is still unknown. New saves remain held until a newer revision fences it.";
      else {
        state.unknownRevision = null;
        state.message = `App notification settings read at revision ${fresh.revision}. Compare the current values with your draft before saving.`;
      }
    } catch {
      if (turn === epoch)
        state.message =
          "App notification settings could not be verified. Interruptions remain held when policy is unavailable.";
    } finally {
      if (turn === epoch) {
        state.busy = false;
        publish();
      }
    }
  };
  return {
    state,
    check,
    edit(policy: AppNotificationPolicy) {
      if (state.busy) return;
      state.draft = structuredClone(policy);
      publish();
    },
    async save() {
      if (
        state.busy ||
        !deps.canWrite() ||
        !state.current ||
        !state.draft ||
        state.unknownRevision !== null
      )
        return;
      const policy = appNotificationPolicySchema.safeParse(state.draft);
      if (!policy.success) {
        state.message = "Quiet hours require two different valid times.";
        publish();
        return;
      }
      const expectedRevision = state.current.revision;
      state.busy = true;
      publish();
      const result = await actionOutcome(
        () => deps.post({ expectedRevision, policy: policy.data }),
        "Check current app notification settings before saving again.",
      );
      if (result.state === "unknown") {
        state.unknownRevision = expectedRevision;
        state.message = result.message;
        state.busy = false;
        publish();
        return;
      }
      if (result.state === "refused") {
        state.message = result.message;
        state.busy = false;
        publish();
        return;
      }
      const receipt = appNotificationSettingsSchema.safeParse(result.data);
      if (
        !receipt.success ||
        receipt.data.revision !== expectedRevision + 1 ||
        JSON.stringify(receipt.data.policy) !== JSON.stringify(policy.data)
      ) {
        state.unknownRevision = expectedRevision;
        state.message =
          "The save receipt could not be verified. Check current settings; no retry was sent.";
        state.busy = false;
        publish();
        return;
      }
      state.unknownRevision = expectedRevision;
      state.busy = false;
      await check();
      if (
        state.current &&
        state.current.revision === receipt.data.revision &&
        JSON.stringify(state.current.policy) === JSON.stringify(policy.data)
      )
        state.draft = null;
      publish();
    },
  };
}

/** The real native path waits for current saved policy; uncertainty never permits interruption. */
export function createAppNotificationSender(deps: {
  read(): Promise<unknown>;
  current(): boolean;
  status(message: string): void;
  sendNative(notification: HaltNotification): () => void;
  now?: () => Date;
}) {
  return async (
    notification: HaltNotification,
  ): Promise<(() => void) | null> => {
    try {
      const saved = appNotificationSettingsSchema.parse(await deps.read());
      if (
        !deps.current() ||
        !notification.beforeNative ||
        !(await notification.beforeNative()) ||
        !deps.current()
      )
        return null;
      if (!appInterruptionAllowed(saved.policy, deps.now?.() ?? new Date())) {
        deps.status(
          "App interruptions are off or quiet hours are active. Source records remain available.",
        );
        return null;
      }
      return deps.sendNative(notification);
    } catch {
      if (deps.current())
        deps.status(
          "App notification policy is unavailable. Interruptions are held.",
        );
      return null;
    }
  };
}
