import { useEffect, useRef, useState } from "preact/hooks";
import { actionOutcome } from "../../../docs/js/action-outcome";
import { readHearth } from "../../../docs/js/hearth-read";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import type { KeeperProposal } from "../../../types/keeper-proposal";
import {
  createKeeperShiftIdentities,
  KEEPER_SHIFT_IDENTITIES,
} from "./keeper-shift-identities";
import { createKeeperShiftReviewOwner } from "./keeper-shift-review-owner";

const base = (projectId: string, proposalId: string) =>
  `/projects/${encodeURIComponent(projectId)}/keeper/proposals/${encodeURIComponent(proposalId)}/shift-start`;

/** One app-root owner shared by the Keeper page and its drawer. */
export function useKeeperShiftReviews(writesAllowed: boolean) {
  const writes = useRef(writesAllowed);
  writes.current = writesAllowed;
  const [, paint] = useState(0);
  const held = useRef<ReturnType<typeof createKeeperShiftReviewOwner> | null>(
    null,
  );
  if (!held.current) {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* A Start must remain unavailable if its metadata cannot be saved. */
    }
    held.current = createKeeperShiftReviewOwner({
      canWrite: () => writes.current,
      requestId: () => crypto.randomUUID(),
      identities: createKeeperShiftIdentities({
        storage,
        withLock: async (work) => {
          if (!navigator.locks)
            throw Error(
              "Cross-window Shift identity ownership is unavailable.",
            );
          return navigator.locks.request(
            KEEPER_SHIFT_IDENTITIES,
            { signal: AbortSignal.timeout(30_000) },
            work,
          );
        },
      }),
      readOptions: (projectId) =>
        readOperatorRoute(
          `/projects/${encodeURIComponent(projectId)}/shifts/options`,
          { ...pageReads(), fetch: operatorRead },
        ),
      readOriginal: (projectId, proposalId, requestId) =>
        readHearth(
          `/__agent-forge${base(projectId, proposalId)}/${encodeURIComponent(requestId)}`,
          async (response) => {
            let raw: unknown;
            try {
              raw = await response.json();
            } catch {
              throw Error("The protected original could not be verified.");
            }
            if (
              !raw ||
              typeof raw !== "object" ||
              !("ok" in raw) ||
              !("data" in raw)
            )
              throw Error("The protected original could not be verified.");
            if (
              response.status === 404 &&
              raw.ok === false &&
              raw.data === null
            )
              return null;
            if (!response.ok || raw.ok !== true)
              throw Error("The protected original could not be read.");
            return raw.data;
          },
          { ...pageReads(), fetch: operatorRead },
        ),
      postStart: (projectId, proposalId, request) =>
        actionOutcome(
          () =>
            operatorPost(
              `/__agent-forge${base(projectId, proposalId)}`,
              request,
            ),
          "Check the exact original Shift request before retrying.",
        ),
    });
  }
  const owner = held.current;
  useEffect(() => owner.subscribe(() => paint((value) => value + 1)), [owner]);
  useEffect(() => () => owner.dispose(), [owner]);
  return {
    owner,
    get: (
      source: KeeperProposal,
      revision: number,
      originalOnly = false,
      requestId?: string,
    ) => owner.get(source, revision, originalOnly, requestId),
  };
}
