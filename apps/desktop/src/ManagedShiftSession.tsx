import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { operatorRead } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import type { SessionObservationDetail } from "../../../types/session-observations";
import { managedShiftHref } from "./managed-shift-navigation";
import {
  createManagedShiftSessionClient,
  managedShiftTarget,
  managedShiftTargetKey,
} from "./managed-shift-session-client";
import { observationHref } from "./ObservedSessionDetail";
import { ProjectShiftAttempts } from "./ProjectShiftAttempts";
import "./observed-session.css";

/** No action client or ordinary composer is connected to this managed session surface. */
export function ManagedShiftSession({
  projectId,
  workspace,
  sessionId,
  owner,
  expectedRequestId,
  parent,
}: {
  projectId: string;
  workspace: string;
  sessionId: string;
  owner: unknown;
  expectedRequestId?: string;
  parent: SessionObservationDetail["parent"] | undefined;
}) {
  const [, paint] = useState(0),
    held = useRef<ReturnType<typeof createManagedShiftSessionClient> | null>(
      null,
    );
  if (!held.current)
    held.current = createManagedShiftSessionClient({
      read: (path) =>
        readOperatorRoute(path, { ...pageReads(), fetch: operatorRead }),
      changed: () => paint((value) => value + 1),
    });
  const client = held.current,
    target = managedShiftTarget(
      projectId,
      workspace,
      sessionId,
      owner,
      expectedRequestId,
    ),
    targetKey = managedShiftTargetKey(target);
  useEffect(() => {
    void client.activate(target);
    return () => {
      void client.activate(null);
    };
  }, [client, targetKey]);
  useEffect(() => () => client.close(), [client]);
  const view = client.forTarget(target),
    receipt = target ? view.receipt : null;
  return (
    <section
      class="af-observed-session af-owned-session"
      aria-label="Managed Shift session"
    >
      <header>
        <p class="af-wb-eyebrow">App-owned · read-only attendance</p>
        <h1>Shift session</h1>
        <p class="af-observed-address">{sessionId}</p>
        <p>
          Running attempts cannot receive Chat turns here. Whole-Shift controls
          remain in the original Shift view. Ended-session continuation is
          unavailable here.
        </p>
        <a href={observationHref(projectId, null)}>All project sessions</a>
        {target && (
          <p>
            <a
              href={managedShiftHref({
                projectId,
                requestId: target.origin.originalRequestId,
                sessionId: null,
              })}
            >
              Open owning Shift {target.origin.shiftId}
            </a>
          </p>
        )}
        {parent && (
          <p>
            {parent.available ? (
              <a href={observationHref(projectId, parent.id)}>
                Open parent {parent.id}
              </a>
            ) : (
              <>
                Parent {parent.id} is unavailable in this project. This child
                remains visible.
              </>
            )}
          </p>
        )}
      </header>
      {!target && (
        <p role="alert">
          This session's managed Shift source could not be verified. No private
          attempt or action was opened.
        </p>
      )}
      {target && (view.loading || (!receipt && !view.error)) && (
        <p role="status">Verifying the original Shift…</p>
      )}
      {view.error && <p role="alert">{view.error}</p>}
      <Button
        aria-disabled={!target || view.loading}
        onClick={() => {
          if (target && !view.loading) void client.activate(target);
        }}
      >
        Refresh original Shift
      </Button>
      {receipt && target && (
        <ProjectShiftAttempts
          receipt={receipt}
          selectedSessionId={sessionId}
          expectedOrigin={target.origin}
          onSelect={(id) => {
            window.location.hash = managedShiftHref({
              projectId,
              requestId: receipt.intent.request.requestId,
              sessionId: id,
            }).slice(1);
          }}
        />
      )}
    </section>
  );
}
