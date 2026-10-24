import { useEffect, useRef, useState } from "preact/hooks";
import { appStream } from "../../../docs/js/use-stream";
import {
  createSmithsClient,
  type SmithsClient,
  type SmithsState,
} from "./smiths-client";
import { createSmithsReads } from "./smiths-read";

/** One observer on the existing app ledger stream; this surface has no write dependency. */
export function useSmiths(active: boolean, workspace: string | null) {
  const key = JSON.stringify([active, workspace]);
  const held = useRef<{ key: string; client: SmithsClient } | null>(null);
  const [snapshot, paint] = useState<{ key: string; view: SmithsState } | null>(
    null,
  );
  useEffect(() => {
    if (!active) return;
    const client = createSmithsClient(createSmithsReads());
    held.current = { key, client };
    const changed = () => {
      const state = client.get();
      paint({
        key,
        view: {
          ...state,
          configuration: { ...state.configuration },
          scoreboard: { ...state.scoreboard },
        },
      });
    };
    const unsubscribe = client.subscribe(changed);
    let missed = false;
    const refresh = () => {
      if (document.visibilityState !== "visible") {
        missed = true;
        return;
      }
      client.changed();
    };
    const unwatch = appStream().watch(
      [
        "session.started",
        "session.ended",
        "run.phase.entered",
        "run.phase.completed",
        "gate.ran",
        "verdict.bound",
        "review.recorded",
        "council.run.started",
        "council.run.finished",
        "operator.action",
      ],
      refresh,
    );
    const visible = () => {
      if (missed && document.visibilityState === "visible") {
        missed = false;
        client.changed();
      }
    };
    document.addEventListener("visibilitychange", visible);
    void client.refreshConfiguration();
    void client.refreshScoreboard();
    changed();
    return () => {
      if (held.current?.client === client) held.current = null;
      unsubscribe();
      unwatch();
      document.removeEventListener("visibilitychange", visible);
      client.dispose();
    };
  }, [key]);
  return {
    client: held.current?.key === key ? held.current.client : null,
    view: snapshot?.key === key ? snapshot.view : null,
  };
}
export type SmithsController = ReturnType<typeof useSmiths>;
