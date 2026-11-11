import {
  type HearthLogSnapshot,
  hearthLogSnapshotSchema,
} from "../../desktop/app-hearth-log-protocol";
import type { ReadRoute } from "../api";
import { noParameters } from "./operator-reads";

export function hearthLogRead(read: () => HearthLogSnapshot): ReadRoute<null> {
  return {
    kind: "read",
    method: "GET",
    path: "/app-settings/hearth/logs",
    operatorOnly: true,
    validate(request) {
      const parameters = noParameters(request);
      if (!parameters.ok) return parameters;
      if (
        request.body !== undefined ||
        request.headers["transfer-encoding"] !== undefined ||
        (request.headers["content-length"] !== undefined &&
          request.headers["content-length"] !== "0")
      )
        return {
          ok: false,
          error: "Hearth service logs accept no request body.",
        };
      return { ok: true, value: null };
    },
    read() {
      try {
        return { status: 200, data: hearthLogSnapshotSchema.parse(read()) };
      } catch {
        return {
          status: 503,
          error:
            "Hearth service log could not be verified. Keep the last read values; no empty history is inferred.",
        };
      }
    },
  };
}
