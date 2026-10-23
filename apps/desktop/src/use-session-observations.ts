import { useEffect, useRef, useState } from "preact/hooks";
import { readHearth } from "../../../docs/js/hearth-read";
import { operatorRead } from "../../../docs/js/operator";
import { appStream, pageReads } from "../../../docs/js/use-stream";
import { readSessionObservationResponse } from "./session-observation-response";
import { createSessionObservationsClient } from "./session-observations-client";

const base = (projectId: string) =>
  `/__agent-forge/projects/${encodeURIComponent(projectId)}/session-observations`;

/** One app-root metadata cache, using the existing shared event stream and protected GETs only. */
export function useSessionObservations(
  projectId: string | null,
  sessionId: string | null,
  workspace: string | null,
) {
  const [, paint] = useState(0);
  const held = useRef<ReturnType<
    typeof createSessionObservationsClient
  > | null>(null);
  if (!held.current)
    held.current = createSessionObservationsClient({
      index: (id) =>
        readHearth(
          base(id),
          (response) => readSessionObservationResponse(response, "index"),
          { ...pageReads(), fetch: operatorRead },
        ),
      detail: (id, session, after) =>
        readHearth(
          `${base(id)}/${encodeURIComponent(session)}?after=${after}&limit=100`,
          (response) => readSessionObservationResponse(response, "detail"),
          { ...pageReads(), fetch: operatorRead },
        ),
    });
  const client = held.current;
  useEffect(
    () => client.subscribe(() => paint((value) => value + 1)),
    [client],
  );
  useEffect(() => {
    client.activate(projectId, sessionId, workspace);
  }, [client, projectId, sessionId, workspace]);
  useEffect(
    () =>
      appStream().watch(
        [
          "operator.action",
          "session.started",
          "session.ended",
          "prompt.submitted",
          "tool.called",
        ],
        () => client.changed(),
      ),
    [client],
  );
  useEffect(() => () => client.dispose(), [client]);
  return client;
}
