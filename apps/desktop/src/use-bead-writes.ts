import { useEffect, useRef, useState } from "preact/hooks";
import { z } from "zod";
import { actionOutcome } from "../../../docs/js/action-outcome";
import { operatorPost } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import { createDesktopBeadWrites } from "./bead-writes-client";

const bound = z.number().int().positive().max(10000);
const optionsSchema = z.object({
  types: z
    .array(z.enum(["task", "feature", "bug", "chore", "epic"]))
    .min(1)
    .max(5),
  priorities: z
    .array(
      z.object({
        value: z.enum(["P0", "P1", "P2", "P3", "P4"]),
        tier: z.string().max(100),
        meaning: z.string().max(1000),
      }),
    )
    .min(1)
    .max(5),
  defaultPriority: z.enum(["P0", "P1", "P2", "P3", "P4"]),
  complexities: z.array(z.enum(["low", "medium", "high"])).length(3),
  limits: z.object({
    title: bound.max(200),
    description: bound.max(4000),
    acceptance: bound.max(2000),
    comment: bound.max(4000),
    reason: bound.max(1000),
    labels: bound.max(30),
    label: bound.max(100),
    fileMap: bound.max(100),
  }),
});
export type DesktopBeadOptions = z.infer<typeof optionsSchema>;
export type DesktopBeadWrites = ReturnType<typeof useBeadWrites>;

/** One metadata journal at the app root survives project and destination changes. */
export function useBeadWrites(writesAllowed: boolean, reload: () => void) {
  const current = useRef({ writesAllowed, reload });
  current.current = { writesAllowed, reload };
  const [, paint] = useState(0);
  const held = useRef<ReturnType<typeof createDesktopBeadWrites> | null>(null);
  if (!held.current) {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      /* The client refuses before sending. */
    }
    held.current = createDesktopBeadWrites({
      storage,
      requestId: () => crypto.randomUUID(),
      canWrite: () => current.current.writesAllowed,
      changed: () => current.current.reload(),
      withJournalLock: async (work) => {
        if (!navigator.locks)
          return Promise.reject(Error("Shared write lock unavailable"));
        return navigator.locks.request(
          "agent-forge.desktop-bead-writes.v1",
          { signal: AbortSignal.timeout(30_000) },
          work,
        );
      },
      post: (scope, action, id, body) =>
        actionOutcome(
          () =>
            operatorPost(
              `/__agent-forge/projects/${encodeURIComponent(scope.projectId)}/beads${action === "create" ? "" : `/${encodeURIComponent(id ?? "")}/${action}`}`,
              body,
            ),
          "Outcome unknown: check the bead before trying anything else.",
        ),
    });
  }
  const client = held.current;
  useEffect(() => client.subscribe(() => paint((n) => n + 1)), [client]);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === "agent-forge.desktop-bead-writes.v1") client.refresh();
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, [client]);
  const [options, setOptions] = useState<DesktopBeadOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    void readOperatorRoute<unknown>("/beads/options", pageReads())
      .then((value) => {
        const parsed = optionsSchema.safeParse(value);
        if (
          !parsed.success ||
          !parsed.data.priorities.some(
            (p) => p.value === parsed.data.defaultPriority,
          )
        )
          throw Error("Unsupported bead options");
        if (active) {
          setOptions(parsed.data);
          setError(null);
        }
      })
      .catch(() => {
        if (active) {
          setOptions(null);
          setError(
            "The hearth's bead options could not be verified. Refresh them before sending a write.",
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);
  return {
    client,
    options,
    error,
    loading,
    writesAllowed,
    refresh: () => setRevision((n) => n + 1),
  };
}
