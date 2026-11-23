import {
  createNativeUpdateAuthorization,
  nativeUpdateAuthorizationSchema,
} from "../../desktop/native-update-authorization";
import type { ActionRoute } from "../api";
import { noParameters } from "./operator-reads";
export function nativeUpdateAuthorizationRoute(input: {
  root: string;
  home: string;
}): ActionRoute<ReturnType<typeof nativeUpdateAuthorizationSchema.parse>> {
  const authorize = createNativeUpdateAuthorization(input);
  return {
    kind: "action",
    method: "POST",
    path: "/app-settings/native-updates/authorize",
    action: "app.native-updates.authorize",
    maxBodyBytes: 256,
    rejectDuplicateBodyKeys: true,
    validate(request) {
      const parameters = noParameters(request);
      if (!parameters.ok) return parameters;
      const parsed = nativeUpdateAuthorizationSchema.safeParse(request.body);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, error: "authorization-unavailable" };
    },
    subject: (request) => ({
      target: request.requestId,
      family: "native-update",
      requestId: request.requestId,
    }),
    effect(request, context) {
      try {
        return { status: 200, data: authorize(request, context?.auditEventId) };
      } catch {
        return { status: 503, error: "authorization-unavailable" };
      }
    },
  };
}
