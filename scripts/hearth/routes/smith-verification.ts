import {
  APPRENTICE_VERIFICATION,
  MAX_SMITH_VERIFICATION_BYTES,
  smithVerificationReadSchema,
  smithVerificationRowSchema,
} from "../../smith-verification";
import type { ReadRoute } from "../api";
import { noParameters, type ReadDeps } from "./operator-reads";

/** A fixed served-tracker read; it grants neither project membership nor write authority. */
export function smithVerificationRoute(deps: ReadDeps): ReadRoute<null> {
  return {
    kind: "read",
    method: "GET",
    path: "/smiths/verification",
    operatorOnly: true,
    validate: noParameters,
    read: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutMs = deps.bdTimeoutMs ?? 15_000;
        const result = await Promise.race([
          Promise.resolve(
            deps.runBd(
              ["--readonly", "show", APPRENTICE_VERIFICATION, "--json"],
              { timeoutMs },
            ),
          ),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(Error("Verification read deadline")),
              timeoutMs,
            );
          }),
        ]);
        if (
          result.status !== 0 ||
          new TextEncoder().encode(result.stdout).byteLength >
            MAX_SMITH_VERIFICATION_BYTES
        )
          throw Error("Verification read unavailable");
        let raw: unknown;
        try {
          raw = JSON.parse(result.stdout);
        } catch {
          throw Error("Verification read is not JSON");
        }
        if (!Array.isArray(raw) || raw.length !== 1)
          throw Error("Verification identity unavailable");
        const row = smithVerificationRowSchema.parse(raw[0]);
        const data = smithVerificationReadSchema.parse({
          workspace: deps.workspace,
          checkedAt: new Date().toISOString(),
          task: {
            id: row.id,
            title: row.title,
            status: row.status,
            priority: row.priority ?? null,
            description: row.description ?? "",
            acceptanceCriteria: row.acceptance_criteria ?? "",
            notes: row.notes ?? "",
            updatedAt: row.updated_at ?? null,
          },
        });
        if (
          new TextEncoder().encode(JSON.stringify(data)).byteLength >
          MAX_SMITH_VERIFICATION_BYTES
        )
          throw Error("Verification projection exceeds its bound");
        return { status: 200, data };
      } catch {
        return {
          status: 503,
          error:
            "The verification task could not be read and verified from this hearth’s tracker. Retry to check its current record.",
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
