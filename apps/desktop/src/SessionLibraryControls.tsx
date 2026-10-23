import { useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Dialog } from "../../../docs/js/ds/Dialog";
import type { OwnedCodingSessionRecord } from "../../../types/codex-owned-task";
import type { OwnedSessionView } from "./session-client";
import { ownedSessionControls } from "./session-controls";
import type { SessionLibraryClient } from "./session-library-client";

export function SessionLibraryControls({
  record,
  session,
  library,
  writesAllowed,
  onContinue,
  onPermissions,
}: {
  record: OwnedCodingSessionRecord;
  session: OwnedSessionView;
  library: SessionLibraryClient;
  writesAllowed: boolean;
  onContinue(): void;
  onPermissions?: (() => void) | undefined;
}) {
  const view = library.current();
  const selected =
    view?.record.id === record.id &&
    view.record.projectId === record.projectId &&
    view.record.requestId === record.requestId &&
    view.record.requestHash === record.requestHash &&
    view.record.workspace === record.workspace
      ? view
      : null;
  const [copied, setCopied] = useState("");
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement>(null);
  const controls = ownedSessionControls({
    record,
    page: session.page,
    loaded: session.loaded,
    live: session.live,
    pending: !!session.pending,
    stopping: !!session.stopping,
    feedInterrupted: session.feedInterrupted,
    readError: session.readError,
  });
  return (
    <>
      <Button
        onClick={(event) => {
          opener.current = event.currentTarget;
          setOpen(true);
        }}
      >
        Session actions
      </Button>
      {selected?.pending && (
        <span role="status" class="af-session-note">
          Archive change awaits confirmation.
        </span>
      )}
      {!selected?.pending && selected?.error && (
        <span role="status" class="af-session-note">
          Session actions need attention.
        </span>
      )}
      <Dialog
        open={open}
        title="Session actions"
        titleId="owned-session-actions-title"
        onClose={() => setOpen(false)}
        returnFocusRef={opener}
        class="af-session-library-dialog"
      >
        <div
          class="af-session-library-panel"
          role="region"
          aria-label="Session actions and support"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the named bounded actions region supports keyboard scrolling.
          tabIndex={0}
        >
          <p>
            Export downloads the complete saved revision. Running work can add
            later activity. Archive hides this session from the app list and
            keeps its history and running work.
          </p>
          <div class="af-session-composer-row">
            <Button
              disabled={!selected || selected.exporting}
              onClick={() => {
                void library.exportTranscript();
              }}
            >
              {selected?.exporting
                ? "Preparing transcript…"
                : "Export saved transcript"}
            </Button>
            <Button
              disabled={!selected || !library.canChange()}
              onClick={() => {
                if (selected) void library.change(!selected.entry?.archived);
              }}
            >
              {selected?.entry?.archived
                ? "Restore session"
                : "Archive session"}
            </Button>
            <Button
              disabled={!selected || selected.checking}
              onClick={() => {
                void library.check();
              }}
            >
              Check archive status
            </Button>
          </div>
          {selected?.pending && (
            <div class="af-session-warning" role="status">
              <p>
                Original{" "}
                {selected.pending.original.archived ? "archive" : "restore"}{" "}
                change is held until its exact receipt is confirmed.
              </p>
              <Button
                disabled={
                  !writesAllowed || selected.posting || selected.checking
                }
                onClick={() => {
                  void library.retry();
                }}
              >
                Retry original archive change
              </Button>
            </div>
          )}
          {(selected?.notice || selected?.error || copied) && (
            <div role="status" class="af-session-note">
              {selected?.notice && <p>{selected.notice}</p>}
              {selected?.error && <p role="alert">{selected.error}</p>}
              {copied && <p>{copied}</p>}
            </div>
          )}
          <div class="af-session-composer-row">
            <Button
              disabled={!writesAllowed || !controls.resume.available}
              onClick={() => {
                setOpen(false);
                requestAnimationFrame(onContinue);
              }}
            >
              Continue this Chat
            </Button>
            <Button
              disabled={!controls.commandPreview}
              onClick={() => {
                if (controls.commandPreview)
                  void navigator.clipboard
                    .writeText(controls.commandPreview)
                    .then(() =>
                      setCopied(
                        "Original CLI preview and input instructions copied.",
                      ),
                    )
                    .catch(() =>
                      setCopied("The CLI preview could not be copied."),
                    );
              }}
            >
              Copy original CLI preview
            </Button>
            <Button disabled>Fork session</Button>
            <Button disabled>Open session in terminal</Button>
            <Button
              disabled={
                !writesAllowed ||
                !controls.permissions.available ||
                !onPermissions
              }
              onClick={() => {
                setOpen(false);
                requestAnimationFrame(() => onPermissions?.());
              }}
            >
              {controls.permissions.inline
                ? "Review native permissions"
                : "Live permission controls"}
            </Button>
          </div>
          <dl class="af-session-control-support">
            <dt>Continue Chat</dt>
            <dd>{controls.resume.reason}</dd>
            <dt>Stop</dt>
            <dd>{controls.stop.reason}</dd>
            <dt>Fork</dt>
            <dd>{controls.fork.reason}</dd>
            <dt>Terminal handoff</dt>
            <dd>{controls.terminal.reason}</dd>
            <dt>Permissions</dt>
            <dd>{controls.permissions.reason}</dd>
          </dl>
        </div>
      </Dialog>
    </>
  );
}
