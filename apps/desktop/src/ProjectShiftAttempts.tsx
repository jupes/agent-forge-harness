import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { operatorRead } from "../../../docs/js/operator";
import {
  appStream,
  fetchTransport,
  pageReads,
  readOperatorRoute,
} from "../../../docs/js/use-stream";
import type { ProjectShiftReceipt } from "../../../types/project-shifts";
import type { ProjectShiftAttemptOrigin } from "../../../types/shift-origin";
import { KeeperMarkdown } from "./KeeperMarkdown";
import { keeperTurns } from "./keeper-model";
import { managedShiftHref } from "./managed-shift-navigation";
import {
  createShiftAttemptObserver,
  type ShiftAttemptAddress,
  type ShiftAttemptObserver,
  shiftAttemptAddressKey,
} from "./project-shift-attempt-client";
import {
  SessionActivity,
  SessionOutcome,
  SessionTurnUsage,
} from "./SessionActivity";
import { ownedSessionTurn } from "./session-activity";
import "./session.css";

/** Reads only the dedicated original-shift feed. Generic session actions are intentionally absent. */
export function ProjectShiftAttempts({
  receipt,
  selectedSessionId,
  onSelect,
  expectedOrigin,
}: {
  receipt: ProjectShiftReceipt;
  selectedSessionId?: string;
  onSelect?: (sessionId: string) => void;
  expectedOrigin?: ProjectShiftAttemptOrigin;
}) {
  const { intent } = receipt;
  const [, paint] = useState(0),
    held = useRef<ShiftAttemptObserver | null>(null);
  const address: ShiftAttemptAddress = {
    projectId: intent.projectId,
    originalRequestId: intent.request.requestId,
    shiftId: intent.shiftId,
    workspace: intent.workspace,
    ...(selectedSessionId !== undefined ? { selectedSessionId } : {}),
    ...(expectedOrigin !== undefined ? { expectedOrigin } : {}),
  };
  const addressKey = shiftAttemptAddressKey(address);
  useEffect(() => {
    const base = `/projects/${encodeURIComponent(intent.projectId)}/shifts/requests/${encodeURIComponent(intent.request.requestId)}/attempts`;
    const observer = createShiftAttemptObserver({
      ...address,
      changed: () => paint((value) => value + 1),
      read: () =>
        readOperatorRoute(base, { ...pageReads(), fetch: operatorRead }),
      stream: (id) =>
        fetchTransport(
          `/__agent-forge${base}/${encodeURIComponent(id)}/events`,
          { fetch: operatorRead },
        ),
    });
    held.current = observer;
    const refresh = () => {
      if (document.visibilityState === "visible") void observer.refresh();
    };
    const close = appStream().watch(
      ["session.started", "session.ended", "shift.stopped"],
      refresh,
    );
    const timer = window.setInterval(refresh, 5000);
    refresh();
    return () => {
      held.current = null;
      close();
      window.clearInterval(timer);
      observer.close();
    };
  }, [addressKey]);
  const view = held.current?.forAddress(address),
    observer = view ? held.current : null,
    page = view?.page;
  const current = page?.turns[0],
    first = page?.frames[0]?.event;
  const requested =
    first?.kind === "user" ? (first.shift?.requestedModel ?? null) : null;
  const report = current
    ? ownedSessionTurn(page ?? null, current.requestId)
    : null;
  return (
    <section
      class="af-project-shift-attempts af-owned-session"
      aria-label="Private shift activity"
    >
      <div class="af-shift-section-heading">
        <div>
          <h3>Private shift activity</h3>
          <p>
            Read-only attendance. Whole-Shift Stop and recovery are available
            only in the original Shift view.
          </p>
        </div>
        <Button
          aria-disabled={!observer || view?.loading}
          onClick={() => {
            if (!view?.loading) void observer?.refresh();
          }}
        >
          Refresh attempts
        </Button>
      </div>
      {view?.error && <p role="alert">{view.error}</p>}
      <div class="af-shift-attempt-toolbar">
        <label>
          Attempt
          <select
            aria-label="Select shift attempt"
            value={view?.selectedId ?? ""}
            onChange={(event) => {
              const id = event.currentTarget.value;
              if (!id) return;
              if (onSelect) onSelect(id);
              else observer?.select(id);
            }}
          >
            <option value="">
              {view?.index?.items.length
                ? "Choose an attempt"
                : "No private attempts reported"}
            </option>
            {view?.index?.items.map(({ session }) => (
              <option key={session.id} value={session.id}>
                {session.origin?.kind === "shift"
                  ? session.origin.beadId
                  : "Unknown bead"}{" "}
                · attempt{" "}
                {session.origin?.kind === "shift"
                  ? session.origin.attempt
                  : "—"}{" "}
                · {session.provider} · {session.smith}
              </option>
            ))}
          </select>
        </label>
        {selectedSessionId === undefined && (
          <Button
            aria-pressed={view?.followLatest ?? true}
            onClick={() => observer?.followLatest()}
          >
            Follow latest attempt
          </Button>
        )}
        {view?.selectedId && (
          <Button onClick={() => observer?.reload()}>
            Reload private history
          </Button>
        )}
      </div>
      {view?.index && (
        <p class="af-session-note">
          Attempt index checked{" "}
          <time dateTime={view.index.asOf}>
            {new Date(view.index.asOf).toLocaleString()}
          </time>
          . Index metadata does not prove a provider started or finished.
        </p>
      )}
      {view?.selectedId && (
        <p>
          <a
            href={managedShiftHref({
              projectId: intent.projectId,
              requestId: intent.request.requestId,
              sessionId: view.selectedId,
            })}
          >
            Open this attempt in Sessions
          </a>
        </p>
      )}
      <p role="status">
        {view?.notice || "Reading original shift attempt metadata…"}
      </p>
      {current && (
        <p>
          <strong>
            {view?.loaded
              ? `Verified saved turn: ${current.phase}`
              : "Reading complete private history…"}
          </strong>
          {view?.loaded && !view.live ? " · Live updates interrupted" : ""}
        </p>
      )}
      {keeperTurns(page ?? null).map((turn) => (
        <div key={turn.id}>
          <details>
            <summary>Original private input</summary>
            <pre class="af-shift-private-input">{turn.question}</pre>
          </details>
          <section class="af-shift-private-reply" aria-label="Provider text">
            <KeeperMarkdown
              text={turn.reply || "No provider text reported yet."}
            />
          </section>
        </div>
      ))}
      {report && (
        <>
          <SessionActivity value={report} />
          <SessionTurnUsage value={report} requestedModel={requested} />
          {view?.loaded && <SessionOutcome value={report.outcome} />}
        </>
      )}
    </section>
  );
}
