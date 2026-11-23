import { appAppearanceWriteSchema } from "../../projects/app-appearance-protocol";
import {
  AppAppearanceSettingsError,
  createAppAppearanceStore,
} from "../../projects/app-appearance-store";
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
        error instanceof AppAppearanceSettingsError
          ? error.status
          : unknownStatus,
      error:
        error instanceof AppAppearanceSettingsError
          ? error.message
          : "Appearance settings are unavailable.",
    };
  }
}
export function appAppearanceSettingsRoutes(home: string) {
  const store = createAppAppearanceStore(home);
  const read: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    operatorOnly: true,
    path: "/app-settings/appearance",
    validate: noParameters,
    read: () => answer(() => store.read()),
  };
  const write: ActionRoute = {
    kind: "action",
    method: "POST",
    path: "/app-settings/appearance",
    action: "app.settings.appearance",
    maxBodyBytes: 4096,
    rejectDuplicateBodyKeys: true,
    validate(request) {
      const params = noParameters(request);
      if (!params.ok) return params;
      const parsed = appAppearanceWriteSchema.safeParse(request.body);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, error: "Invalid appearance settings." };
    },
    subject: () => ({ target: "app-appearance" }),
    effect: (input) => answer(() => store.write(input), 504),
  };
  return { read, write };
}
