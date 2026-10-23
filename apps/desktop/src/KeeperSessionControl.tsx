import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import type { KeeperClient } from "./keeper-client";
import { type KeeperSessionSelection, keeperSession } from "./keeper-session";
import { openProject } from "./projects-model";

/** One owned standing turn today; observational ledger rows never become stop targets. */
export function KeeperSessionControl({
  projectId,
  client,
  writesAllowed,
  observedSelected,
}: {
  projectId: string;
  client: KeeperClient;
  writesAllowed: boolean;
  observedSelected: number;
}): JSX.Element {
  const state = client.get(projectId),
    session = keeperSession(projectId, state.page);
  const [selected, setSelected] = useState<KeeperSessionSelection | null>(null);
  const matches = Boolean(
    selected &&
      session &&
      selected.sessionId === session.sessionId &&
      selected.requestId === session.requestId,
  );
  const eligible = Boolean(matches && session?.canStop);
  return (
    <section
      class="af-overview-panel af-owned-session"
      aria-label="Owned Keeper session"
    >
      <h2>Owned Keeper session</h2>
      <p>
        This hearth can stop the Keeper turn it owns. Ledger observations are
        read-only; their ids grant no process control.
      </p>
      {session ? (
        <>
          <label>
            <input
              type="checkbox"
              aria-label={`Select owned Keeper session ${session.sessionId}`}
              checked={matches}
              disabled={!session.canStop || Boolean(state.stopping)}
              onChange={(event) =>
                setSelected(
                  event.currentTarget.checked
                    ? {
                        sessionId: session.sessionId,
                        requestId: session.requestId,
                      }
                    : null,
                )
              }
            />
            {session.provider} · {session.sessionId}
          </label>
          <p>
            Actual CLI identity · {session.phase} ·{" "}
            <time dateTime={session.updatedAt}>
              {new Date(session.updatedAt).toLocaleString()}
            </time>
          </p>
          {session.reason && <p>{session.reason}</p>}
          <Button href={openProject(projectId, "keeper")}>
            Open Keeper session
          </Button>
        </>
      ) : (
        <p>
          No current Keeper session identity is confirmed by the private
          conversation read.
        </p>
      )}
      <p>
        {observedSelected + (matches ? 1 : 0)} selected · {eligible ? 1 : 0}{" "}
        eligible. {observedSelected} selected ledger observations remain
        read-only.
      </p>
      <Button
        disabled={
          !writesAllowed ||
          !state.live ||
          !eligible ||
          state.stopPosting ||
          Boolean(state.stopping)
        }
        onClick={() => {
          if (selected) void client.stopSession(projectId, selected);
        }}
      >
        Stop selected
      </Button>
      {state.notice && <p role="status">{state.notice}</p>}
      {state.stopping && (
        <Button
          onClick={() => {
            void client.check(projectId);
          }}
        >
          Check selected Stop
        </Button>
      )}
      {state.stopUnknown && session && state.stopping === session.requestId && (
        <Button
          disabled={!writesAllowed || state.stopPosting}
          onClick={() => {
            void client.stopSession(projectId, session, true);
          }}
        >
          Retry original Stop
        </Button>
      )}
    </section>
  );
}
