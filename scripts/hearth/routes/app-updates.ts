import { z } from "zod";
import {
  type AppUpdateCheck,
  appUpdateResultSchema,
} from "../../desktop/app-update-protocol";
import type { ActionRoute } from "../api";
import { noParameters } from "./operator-reads";

const empty = z.object({}).strict();
export function appUpdateCheckRoute(check: AppUpdateCheck): ActionRoute<null> {
  return {
    kind: "action",
    method: "POST",
    path: "/app-settings/updates/check",
    action: "app.updates.check",
    maxBodyBytes: 128,
    rejectDuplicateBodyKeys: true,
    validate(request) {
      const parameters = noParameters(request);
      if (!parameters.ok) return parameters;
      return empty.safeParse(request.body).success
        ? { ok: true, value: null }
        : { ok: false, error: "Update check accepts an empty object only." };
    },
    subject: () => ({ target: "app-updates" }),
    async effect() {
      try {
        return {
          status: 200,
          data: appUpdateResultSchema.parse(await check()),
        };
      } catch {
        return {
          status: 504,
          error:
            "The update check could not be confirmed. No installation was requested.",
        };
      }
    },
  };
}
