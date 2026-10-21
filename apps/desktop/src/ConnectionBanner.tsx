import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Tag } from "../../../docs/js/ds/Tag";
import { readHearth } from "../../../docs/js/hearth-read";
import {
  operatorPost,
  refreshPageSession,
  setPagePostProblem,
} from "../../../docs/js/operator";
import { appStream } from "../../../docs/js/use-stream";
import { HEALTH_ROUTE } from "../../../scripts/hearth/paths";
import {
  createDesktopConnection,
  type DesktopRecovery,
} from "./connection-recovery";
import "./connection.css";

let pageConnection: ReturnType<typeof createDesktopConnection> | null = null;

/** Installed before rendering, so even an early click cannot bypass the desktop write guard. */
export function installDesktopConnection(): void {
  if (pageConnection !== null) return;
  pageConnection = createDesktopConnection({
    stream: appStream(),
    health: () =>
      readHearth(HEALTH_ROUTE, async (response) => {
        const answer: unknown = await response.json();
        if (
          !response.ok ||
          answer === null ||
          typeof answer !== "object" ||
          !("ok" in answer) ||
          answer.ok !== true ||
          !("data" in answer)
        )
          throw new Error("Health unavailable");
        return answer.data;
      }),
    post: operatorPost,
    refreshSession: refreshPageSession,
  });
  setPagePostProblem((url) => pageConnection!.postProblem(url));
}

export function ConnectionBannerView({
  state,
  restart,
  acknowledge,
}: {
  state: DesktopRecovery;
  restart(): void;
  acknowledge(): void;
}): JSX.Element {
  const { connection, busy, unknown, message } = state;
  return (
    <section
      class="af-notice af-desktop-connection"
      aria-label="Hearth connection"
      data-phase={connection.phase}
    >
      <div class="af-desktop-connection-row">
        <div
          role={
            connection.phase === "stopped" ||
            connection.phase === "version-mismatch"
              ? "alert"
              : "status"
          }
          aria-atomic="true"
          class="af-desktop-connection-copy"
        >
          <Tag tone={connection.writesAllowed ? "accent" : "outline"}>
            {busy ? "Restarting" : connection.label}
          </Tag>
          <span>
            {busy
              ? "Restarting the hearth. Workspace actions wait; last received data stays visible."
              : connection.detail}
          </span>
          {connection.lastKnown && connection.lastDataAt !== null ? (
            <time dateTime={new Date(connection.lastDataAt).toISOString()}>
              Last data received{" "}
              {new Date(connection.lastDataAt).toLocaleTimeString()}
            </time>
          ) : null}
        </div>
        {busy || connection.action === "restart" ? (
          <Button
            variant="primary"
            disabled={busy || unknown}
            onClick={restart}
          >
            {busy ? "Restarting…" : "Restart hearth"}
          </Button>
        ) : null}
      </div>
      {message ? (
        <p
          class="af-desktop-recovery-message"
          role={unknown ? "alert" : "status"}
        >
          {unknown ? "Outcome unknown. " : ""}
          {message}
        </p>
      ) : null}
      {unknown ? (
        <Button variant="secondary" onClick={acknowledge}>
          I checked the hearth and pending actions
        </Button>
      ) : null}
    </section>
  );
}

export function useDesktopRecovery(): DesktopRecovery | null {
  const connection = pageConnection;
  const [state, setState] = useState<DesktopRecovery | null>(
    () => connection?.get() ?? null,
  );
  useEffect(() => {
    if (connection === null) return;
    const leave = connection.subscribe(() => setState(connection.get()));
    setState(connection.get());
    return leave;
  }, [connection]);
  return state;
}

export function ConnectionBanner(): JSX.Element | null {
  const state = useDesktopRecovery();
  const connection = pageConnection;
  if (state === null || connection === null) return null;
  return (
    <ConnectionBannerView
      state={state}
      restart={() => void connection.restart()}
      acknowledge={connection.acknowledge}
    />
  );
}
