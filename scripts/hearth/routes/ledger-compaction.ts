import { ledgerCompactionRequestSchema } from "../../desktop/ledger-compaction-protocol";
import {
  type createLedgerCompactionService,
  LedgerCompactionError,
} from "../../ledger/compaction-service";
import type { ActionRoute, ReadRoute, RouteReply } from "../api";
import { noParameters } from "./operator-reads";

function refusal(error: unknown): RouteReply {
  return error instanceof LedgerCompactionError
    ? { status: error.status, error: error.message }
    : {
        status: 504,
        error:
          "Compaction status could not be confirmed. Do not repeat a pending request.",
      };
}
export function ledgerCompactionRoutes(
  service: ReturnType<typeof createLedgerCompactionService>,
) {
  const read: ReadRoute<null> = {
    kind: "read",
    method: "GET",
    operatorOnly: true,
    path: "/app-settings/ledger/compaction",
    validate: noParameters,
    read() {
      try {
        return { status: 200, data: service.read() };
      } catch (error) {
        return refusal(error);
      }
    },
  };
  const action: ActionRoute<
    ReturnType<typeof ledgerCompactionRequestSchema.parse>
  > = {
    kind: "action",
    method: "POST",
    path: "/app-settings/ledger/compact",
    action: "app.ledger.compact",
    maxBodyBytes: 512,
    rejectDuplicateBodyKeys: true,
    validate(request) {
      const parameters = noParameters(request);
      if (!parameters.ok) return parameters;
      const parsed = ledgerCompactionRequestSchema.safeParse(request.body);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            error:
              "Compaction requires a fresh revision, operation id and explicit90day acknowledgement.",
          };
    },
    subject: (value) => ({ target: value.requestId }),
    async effect(value) {
      try {
        return { status: 200, data: await service.run(value) };
      } catch (error) {
        return refusal(error);
      }
    },
  };
  return { read, action };
}
