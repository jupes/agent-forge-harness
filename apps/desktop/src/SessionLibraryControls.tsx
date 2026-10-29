import { useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Dialog } from "../../../docs/js/ds/Dialog";
import type { OwnedCodingSessionRecord } from "../../../types/codex-owned-task";
import { CLAUDE_ALLOWED_TOOLS } from "../../../scripts/executors/claude-tools";
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
  hasDedicatedForkReview = false,
}: {
  record: OwnedCodingSessionRecord;
  session: OwnedSessionView;
  library: SessionLibraryClient;
  writesAllowed: boolean;
  onContinue(): void;
  onPermissions?: (() => void) | undefined;
  hasDedicatedForkReview?: boolean | undefined;
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
  const [terminalReview, setTerminalReview] = useState(false);
  const [terminalReviewed, setTerminalReviewed] = useState(false);
  const opener = useRef<HTMLElement>(null);
  const terminalOpener = useRef<HTMLElement>(null);
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
  const terminalSource = session.page?.frames.find(
    (frame) => frame.seq === 1 && frame.event.kind === "user",
  );
  const terminalText =
    terminalSource?.event.kind === "user" ? terminalSource.event.text : null;
  const terminalSnapshot =
    terminalSource?.event.kind === "user"
      ? terminalSource.event.session
      : undefined;
  const terminalAttempt = selected?.terminalAttempt ?? null;
  const terminalHostAvailable =
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  const terminalHeld =
    selected?.terminalLocalHold ||
    (!!terminalAttempt && terminalAttempt.phase !== "refused");
  const canReviewTerminal =
    writesAllowed &&
    terminalHostAvailable &&
    controls.terminal.available &&
    !selected?.terminalLoading &&
    !selected?.terminalPosting &&
    !terminalHeld;
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
            {!hasDedicatedForkReview && <Button disabled>Fork session</Button>}
            <Button
              disabled={!canReviewTerminal}
              onClick={(event) => {
                terminalOpener.current = event.currentTarget;
                setTerminalReviewed(false);
                setOpen(false);
                setTerminalReview(true);
              }}
            >
              Open Claude Chat in terminal
            </Button>
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
            {!hasDedicatedForkReview && (
              <>
                <dt>Fork</dt>
                <dd>{controls.fork.reason}</dd>
              </>
            )}
            <dt>Terminal handoff</dt>
            <dd>
              {!terminalHostAvailable
                ? "Native terminal handoff is available only on Windows x64."
                : terminalAttempt?.phase === "opened"
                ? "Managed terminal is open. Claude resumption and terminal activity are not synced to this saved Chat."
                : terminalAttempt?.phase === "unknown"
                  ? "Terminal outcome is unknown. Check this original request; another terminal is blocked."
                  : terminalAttempt?.phase === "closed"
                    ? "The managed terminal has closed. Its activity is not synced to this saved Chat."
                    : terminalAttempt?.phase === "refused"
                      ? "No terminal was created. Review the original input before a new explicit attempt."
                      : controls.terminal.reason}
            </dd>
            <dt>Permissions</dt>
            <dd>{controls.permissions.reason}</dd>
          </dl>
          {(selected?.terminalNotice || selected?.terminalError) && (
            <div class="af-session-note" role="status">
              {selected.terminalNotice && <p>{selected.terminalNotice}</p>}
              {selected.terminalError && (
                <p role="alert">{selected.terminalError}</p>
              )}
            </div>
          )}
        </div>
      </Dialog>
      <Dialog
        open={terminalReview}
        title="Review terminal handoff"
        titleId="terminal-handoff-review-title"
        onClose={() => {
          setTerminalReview(false);
          setTerminalReviewed(false);
        }}
        returnFocusRef={terminalOpener}
        class="af-session-library-dialog"
        actions={
          <>
            <Button
              disabled={
                !terminalReviewed ||
                !writesAllowed ||
                !!selected?.terminalPosting ||
                !terminalText
              }
              onClick={() => void library.openTerminal()}
            >
              {selected?.terminalPosting
                ? "Opening terminal…"
                : "Open managed terminal"}
            </Button>
            <Button
              disabled={!!selected?.terminalPosting}
              onClick={() => setTerminalReview(false)}
            >
              Cancel
            </Button>
          </>
        }
      >
        <div class="af-session-library-panel">
          <p>
            Asks Claude to resume this saved Chat in a managed native
            terminal. The original app turn stays ended. This terminal closes
            with Agent Forge. Terminal activity is not synced.
          </p>
          <dl>
            <dt>Saved Chat</dt>
            <dd>{record.id}</dd>
            <dt>Native Claude session</dt>
            <dd>{session.page?.binding?.sessionId ?? "Not verified"}</dd>
            <dt>Saved model and permission mode</dt>
            <dd>
              {terminalSnapshot
                ? `${terminalSnapshot.launch.model} · ${terminalSnapshot.launch.permissionMode ?? "acceptEdits (saved launch default)"} · ${terminalSnapshot.launch.effort ?? "CLI default effort"}`
                : "Not verified"}
            </dd>
          </dl>
          <section aria-label="Original source input">
            <p>Original source input</p>
            {terminalText ? <pre>{terminalText}</pre> : <p>The original source input is unavailable; no terminal will open.</p>}
            {!!terminalSnapshot?.launch.attachments?.length && (
              <div>
                <p>Original attachments</p>
                {terminalSnapshot.launch.attachments.map((attachment) =>
                  attachment.kind === "text" ? (
                    <article key={attachment.name}>
                      <p>{attachment.name}</p>
                      <pre>{attachment.text}</pre>
                    </article>
                  ) : (
                    <figure key={attachment.name}>
                      <img
                        alt={attachment.name}
                        src={`data:${attachment.mediaType};base64,${attachment.data}`}
                      />
                      <figcaption>{attachment.name}</figcaption>
                    </figure>
                  ),
                )}
              </div>
            )}
          </section>
          <p>
            These project tools are enabled. Claude may run them without asking
            you. This action does not send a new prompt.
          </p>
          <ul aria-label="Enabled Claude tools">
            {CLAUDE_ALLOWED_TOOLS.map((tool) => <li key={tool}><code>{tool}</code></li>)}
          </ul>
          {selected?.terminalAttempt?.phase === "unknown" && (
            <p role="alert">
              The previous terminal outcome is unknown. The original request is
              held and cannot be replaced.
            </p>
          )}
          {(selected?.terminalNotice || selected?.terminalError) && (
            <div class="af-session-note" role="status">
              {selected.terminalNotice && <p>{selected.terminalNotice}</p>}
              {selected.terminalError && (
                <p role="alert">{selected.terminalError}</p>
              )}
            </div>
          )}
          <label>
            <input
              type="checkbox"
              checked={terminalReviewed}
              disabled={!terminalText || !!selected?.terminalPosting}
              onChange={(event) =>
                setTerminalReviewed(event.currentTarget.checked)
              }
            />
            I reviewed the original input and attachments, and understand
            terminal activity is not synced to the app.
          </label>
        </div>
      </Dialog>
    </>
  );
}
