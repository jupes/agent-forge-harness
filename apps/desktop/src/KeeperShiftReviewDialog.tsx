import type { JSX, RefObject } from "preact";
import { Button } from "../../../docs/js/ds/Button";
import { Dialog } from "../../../docs/js/ds/Dialog";
import type {
  KeeperShiftReviewEntry,
  KeeperShiftReviewOwner,
} from "./keeper-shift-review-owner";
import { desktopHref } from "./navigation";
import { ProjectShiftFields } from "./ProjectShifts";
import { reviewedProjectShift } from "./project-shift-composer";

export function KeeperShiftReviewDialog({
  entry,
  owner,
  writesAllowed,
  opener,
  onClose,
}: {
  entry: KeeperShiftReviewEntry | null;
  owner: KeeperShiftReviewOwner;
  writesAllowed: boolean;
  opener: RefObject<HTMLElement>;
  onClose(): void;
}): JSX.Element {
  const state = entry?.state ?? null,
    options = state?.options ?? null,
    draft = state?.draft ?? null,
    verified = !!state?.scopeVerified && !!options,
    reviewed =
      options && state?.scopeVerified && draft
        ? reviewedProjectShift(options, draft)
        : null,
    canStart =
      !!entry &&
      !!state &&
      state.status === "ready" &&
      verified &&
      !!options?.availability.start &&
      reviewed?.ok === true &&
      writesAllowed &&
      !entry.loading &&
      !entry.starting,
    canRetry =
      !!entry &&
      !!state?.original &&
      ["held", "unknown"].includes(state.status) &&
      verified &&
      !!options?.availability.start &&
      writesAllowed &&
      !entry.loading &&
      !entry.starting;
  return (
    <Dialog
      open={!!entry}
      title="Review Keeper Shift"
      titleId="af-keeper-shift-review-title"
      onClose={onClose}
      returnFocusRef={opener}
      class="af-session-dialog"
      initialFocus="content"
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {state?.status === "recorded" && state.source.projectId ? (
            <Button
              href={desktopHref({
                projectId: state.source.projectId,
                destination: "workbench",
                selection: null,
              })}
            >
              Open Workbench
            </Button>
          ) : !verified ? (
            <Button
              disabled={!entry || entry.loading || entry.starting}
              onClick={() => {
                if (entry) void owner.check(entry);
              }}
            >
              Check current project scope
            </Button>
          ) : state?.requestId && !state.original ? (
            <Button
              disabled={!entry || entry.loading || entry.starting}
              onClick={() => {
                if (entry) void owner.check(entry);
              }}
            >
              Check original Start
            </Button>
          ) : canRetry ? (
            <Button
              variant="primary"
              disabled={!canRetry}
              onClick={() => {
                if (entry) void owner.retry(entry);
              }}
            >
              Retry exact original
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!canStart}
              onClick={() => {
                if (entry) void owner.start(entry);
              }}
            >
              Start reviewed shift
            </Button>
          )}
        </>
      }
    >
      {state && (
        <>
          <section
            class="af-session-warning"
            aria-label="Keeper proposal source"
          >
            <strong>{state.source.draft.title}</strong>
            <p>{state.source.draft.detail}</p>
            <p>Proposal {state.source.id}</p>
            {state.original && (
              <p>
                Exact original {state.original.start.requestId} is retained. Its
                Shift outcome does not imply provider-task completion.
              </p>
            )}
          </section>
          {entry?.loading && (
            <p role="status">Checking current project scope…</p>
          )}
          {entry?.starting && (
            <p role="status">Sending the reviewed original once…</p>
          )}
          {state.notice && <p role="status">{state.notice}</p>}
          {!verified && !entry?.loading && (
            <p>
              The current project scope is unavailable for a new Start or retry.
              The saved UUID and exact original remain retained.
            </p>
          )}
          {verified && options && !options.availability.start && (
            <p role="alert">
              {options.availability.reason ??
                "Starting a Shift is unavailable."}
            </p>
          )}
          {verified && options && draft && (
            <>
              <p>
                Current project defaults and limits are shown below. The four
                proposal bounds prefill the form; review every field before
                explicitly starting.
              </p>
              <ProjectShiftFields
                options={options}
                draft={draft}
                disabled={state.status !== "ready" || !!state.original}
                setDraft={(value) => entry && owner.edit(entry, value)}
              />
              {!options.availability.start && (
                <p role="alert">
                  {options.availability.reason ??
                    "Starting a Shift is unavailable."}
                </p>
              )}
              {reviewed && !reviewed.ok && (
                <p role="alert">{reviewed.reason}</p>
              )}
              {!state.original && (
                <Button
                  disabled={!!entry?.loading || !!entry?.starting}
                  onClick={() => {
                    if (entry) void owner.open(entry);
                  }}
                >
                  Use current defaults
                </Button>
              )}
              {state.status === "recorded" && (
                <p role="status">
                  A canonical Shift record is confirmed. Open Workbench for its
                  execution status and Stop or recovery controls.
                </p>
              )}
            </>
          )}
          {!writesAllowed && (
            <p role="status">
              Write connection unavailable. Original reads remain available.
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
