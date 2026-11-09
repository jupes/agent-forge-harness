import { appNotificationWriteSchema } from "../../projects/app-notifications-protocol";
import {
  AppNotificationSettingsError,
  createAppNotificationStore,
} from "../../projects/app-notifications-store";
import type { ActionRoute, ReadRoute, RouteReply } from "../api";
import { noParameters } from "./operator-reads";

async function answer(
  work: () => unknown | Promise<unknown>,
  unknownStatus = 503,
): Promise<RouteReply> {
  try {
    return { status: 200, data: await work() };
  } catch (error) {
    return {
      status:
        error instanceof AppNotificationSettingsError
          ? error.status
          : unknownStatus,
      error:
        error instanceof AppNotificationSettingsError
          ? error.message
          : "App notification settings are unavailable.",
    };
  }
}
export function appNotificationSettingsRoutes(home: string) {
  const store = createAppNotificationStore(home);
  const read: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    operatorOnly: true,
    path: "/app-settings/notifications",
    validate: noParameters,
    read: () => answer(() => store.read()),
  };
  const write: ActionRoute = {
    kind: "action",
    method: "POST",
    path: "/app-settings/notifications",
    action: "app.settings.notifications",
    maxBodyBytes: 4096,
    rejectDuplicateBodyKeys: true,
    validate(request) {
      const params = noParameters(request);
      if (!params.ok) return params;
      const parsed = appNotificationWriteSchema.safeParse(request.body);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, error: "Invalid app notification settings." };
    },
    subject: () => ({ target: "app-notifications" }),
    effect: (input) => answer(() => store.write(input), 504),
  };
  return { read, write };
}
