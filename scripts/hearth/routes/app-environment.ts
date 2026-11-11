import {
  ENVIRONMENT_LIMITS,
  environmentRequestSchema,
} from "../../config/environment-protocol";
import {
  type createEnvironmentSettingsService,
  EnvironmentSettingsError,
} from "../../config/environment-service";
import type { ActionRoute, ReadRoute, RouteReply } from "../api";
import { noParameters } from "./operator-reads";

function refusal(error: unknown): RouteReply {
  return error instanceof EnvironmentSettingsError
    ? { status: error.status, error: error.message }
    : {
        status: 504,
        error:
          "The environment result could not be verified. Check its exact receipt before another save.",
      };
}
export function environmentSettingsRoutes(
  service: ReturnType<typeof createEnvironmentSettingsService>,
) {
  const read: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    path: "/app-settings/environment",
    operatorOnly: true,
    validate: noParameters,
    read() {
      try {
        return { status: 200, data: service.read() };
      } catch (error) {
        return refusal(error);
      }
    },
  };
  const save: ActionRoute<ReturnType<typeof environmentRequestSchema.parse>> = {
    kind: "action",
    method: "POST",
    path: "/app-settings/environment",
    action: "app.environment.save",
    maxBodyBytes: ENVIRONMENT_LIMITS.requestBytes,
    rejectDuplicateBodyKeys: true,
    validate(request) {
      const parameters = noParameters(request);
      if (!parameters.ok) return parameters;
      const parsed = environmentRequestSchema.safeParse(request.body);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            error:
              "Environment saves require unique names and the exact reviewed configuration revision.",
          };
    },
    subject: (request) => ({ target: request.requestId }),
    async effect(request) {
      try {
        return { status: 200, data: await service.save(request) };
      } catch (error) {
        return refusal(error);
      }
    },
  };
  return { read, save };
}
