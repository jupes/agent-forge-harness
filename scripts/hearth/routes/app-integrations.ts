import {
  createIntegrationAuthorization,
  integrationAuthorizationRequestSchema,
} from "../../desktop/mcp-authorization";
import type { ActionRoute } from "../api";
import { noParameters } from "./operator-reads";
export function integrationAuthorizationRoute(input: {
  root: string;
  home: string;
}): ActionRoute<
  ReturnType<typeof integrationAuthorizationRequestSchema.parse>
> {
  const authorize = createIntegrationAuthorization(input);
  return {
    kind: "action",
    method: "POST",
    path: "/app-settings/integrations/authorize",
    action: "app.integrations.authorize",
    maxBodyBytes: 256,
    rejectDuplicateBodyKeys: true,
    validate(request) {
      const parameters = noParameters(request);
      if (!parameters.ok) return parameters;
      const parsed = integrationAuthorizationRequestSchema.safeParse(
        request.body,
      );
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, error: "authorization-unavailable" };
    },
    subject: (request) => ({
      target: request.requestId,
      family: "mcp-registration",
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
