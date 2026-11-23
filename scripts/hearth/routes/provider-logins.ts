import { z } from "zod";
import { ConversationError } from "../../conversations/error";
import type { ProviderLoginService } from "../../providers/login";
import {
  type LoginProvider,
  loginProviderSchema,
  loginRequestIdSchema,
} from "../../providers/login-protocol";
import type { ActionRoute, ReadRoute, RouteReply, RouteRequest } from "../api";
import type { ValidationResult } from "../validate";
import { fail, noParameters } from "./operator-reads";

type Address = { provider: LoginProvider; requestId: string };
const startBody = z.object({ requestId: loginRequestIdSchema }).strict();
async function answer(
  work: () => unknown | Promise<unknown>,
): Promise<RouteReply> {
  try {
    return { status: 200, data: await work() };
  } catch (error) {
    if (error instanceof ConversationError)
      return { status: error.status, error: error.message };
    throw error;
  }
}
export function createProviderLoginRoutes(service: ProviderLoginService) {
  function address(request: RouteRequest): ValidationResult<Address> {
    const query = noParameters(request);
    if (!query.ok) return query;
    const provider = loginProviderSchema.safeParse(request.params["provider"]),
      requestId = loginRequestIdSchema.safeParse(request.params["requestId"]);
    return provider.success && requestId.success
      ? {
          ok: true,
          value: { provider: provider.data, requestId: requestId.data },
        }
      : fail("Expected a supported sign-in provider and request UUID.");
  }
  const list: ReadRoute = {
    kind: "read",
    method: "GET",
    path: "/providers/sign-in",
    operatorOnly: true,
    validate: noParameters,
    read: () => answer(() => ({ records: service.list() })),
  };
  const original: ReadRoute<Address> = {
    kind: "read",
    method: "GET",
    path: "/providers/:provider/sign-in/:requestId",
    operatorOnly: true,
    validate: address,
    read: (value) =>
      answer(() => service.read(value.provider, value.requestId)),
  };
  const start: ActionRoute<Address> = {
    kind: "action",
    method: "POST",
    path: "/providers/:provider/sign-in",
    action: "provider.sign-in",
    validate(request) {
      const query = noParameters(request);
      if (!query.ok) return query;
      const provider = loginProviderSchema.safeParse(
          request.params["provider"],
        ),
        body = startBody.safeParse(request.body);
      return provider.success && body.success
        ? {
            ok: true,
            value: { provider: provider.data, requestId: body.data.requestId },
          }
        : fail(
            "Sign-in takes only a supported provider and request UUID. Commands and credentials are not accepted.",
          );
    },
    subject: (value) => ({ target: value.provider }),
    effect: (value) =>
      answer(() => service.start(value.provider, value.requestId)),
  };
  const stop: ActionRoute<Address> = {
    kind: "action",
    method: "POST",
    path: "/providers/:provider/sign-in/:requestId/stop",
    action: "provider.sign-in.stop",
    validate(request) {
      const result = address(request);
      if (!result.ok) return result;
      return z.object({}).strict().safeParse(request.body).success
        ? result
        : fail("Closing a sign-in terminal takes an empty object.");
    },
    subject: (value) => ({ target: value.provider }),
    effect: (value) =>
      answer(() => service.stop(value.provider, value.requestId)),
  };
  return {
    reads: [list, original],
    actions: [start, stop],
    close: () => service.close(),
  };
}
