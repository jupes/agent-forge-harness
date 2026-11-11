import {
  type StartupRequest,
  startupRequestSchema,
} from "../../desktop/app-startup-protocol";
import {
  AppStartupError,
  type createAppStartupService,
} from "../../desktop/app-startup-service";
import type { ActionRoute, ApiRoute, ReadRoute, RouteReply } from "../api";
import { noParameters } from "./operator-reads";

const refusal = (error: unknown): RouteReply =>
  error instanceof AppStartupError
    ? { status: error.status, error: error.message }
    : {
        status: 504,
        error:
          "Startup registration outcome could not be verified. Do not repeat a pending request.",
      };
export function desktopStartupRoutes(
  service: ReturnType<typeof createAppStartupService>,
): ApiRoute[] {
  const read: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    path: "/desktop/startup",
    operatorOnly: true,
    validate: noParameters,
    async read() {
      try {
        return { status: 200, data: await service.read() };
      } catch (error) {
        return refusal(error);
      }
    },
  };
  const write: ActionRoute<StartupRequest> = {
    kind: "action",
    method: "POST",
    path: "/desktop/startup",
    action: "desktop.startup.set",
    maxBodyBytes: 512,
    rejectDuplicateBodyKeys: true,
    validate(request) {
      const params = noParameters(request);
      if (!params.ok) return params;
      const parsed = startupRequestSchema.safeParse(request.body);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            error:
              "Startup registration requires a reviewed installation, revision, fingerprint and boolean setting.",
          };
    },
    subject: (request) => ({ target: request.requestId }),
    async effect(request) {
      try {
        return { status: 200, data: await service.write(request) };
      } catch (error) {
        return refusal(error);
      }
    },
  };
  return [read, write];
}
