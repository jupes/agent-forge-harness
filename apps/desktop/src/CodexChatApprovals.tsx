import { Button } from "../../../docs/js/ds/Button";
import type { CodexChatDecisions } from "./codex-chat-decisions";

const choices = {
  accept: "Allow once",
  decline: "Decline",
  cancel: "Cancel native request",
} as const;
/** Only the current protected live page supplies choices; private history is never an approval source. */
export function CodexChatApprovals({
  client,
  actionable,
}: {
  client: CodexChatDecisions;
  actionable: boolean;
}) {
  const view = client.view();
  if (!view) return null;
  const held = !!view.identity || !!view.identityError;
  return (
    <section class="af-session-approvals" aria-label="Native Codex approvals">
      <div class="af-session-composer-row">
        <h3>Native approvals</h3>
        <Button
          disabled={!actionable || view.loading || view.posting}
          onClick={() => {
            void client.refreshPending();
          }}
        >
          Refresh native approvals
        </Button>
      </div>
      {view.loading && <p role="status">Checking live native requests…</p>}
      {view.error && <p role="alert">{view.error}</p>}
      {view.identityError && <p role="alert">{view.identityError}</p>}
      {view.notice && <p role="status">{view.notice}</p>}
      {view.identity && (
        <div class="af-session-warning">
          <p>
            An original decision is held. No replacement will be sent. Its
            private command and reason are not stored in this browser.
          </p>
          <Button
            disabled={view.checking || view.posting}
            onClick={() => {
              void client.checkOriginal();
            }}
          >
            {view.checking
              ? "Checking original decision…"
              : "Check original decision"}
          </Button>
        </div>
      )}
      {view.posting && (
        <p role="status">Recording the original decision intent…</p>
      )}
      {!view.pending.length && !view.loading && !held && (
        <p class="af-session-note">
          {actionable
            ? "No verified native approval is waiting."
            : "There is no live approval control for this turn."}
        </p>
      )}
      {view.pending.map((item) => (
        <article
          key={item.approval.id}
          class="af-session-approval"
          aria-label={
            item.approval.kind === "command"
              ? "Native command approval"
              : "Native file approval"
          }
        >
          <h4>
            {item.approval.kind === "command"
              ? "Command requested"
              : "File change requested"}
          </h4>
          {item.approval.command !== null && (
            <>
              <p>Actual command</p>
              <pre>{item.approval.command}</pre>
            </>
          )}
          {item.approval.cwd !== null && (
            <p>
              Working directory: <code>{item.approval.cwd}</code>
            </p>
          )}
          <p>
            {item.approval.reason ??
              "The native server did not provide a reason."}
          </p>
          {item.detailsUnavailableReason && (
            <>
              <p class="af-session-warning">{item.detailsUnavailableReason}</p>
              <Button disabled title={item.detailsUnavailableReason}>
                Allow once · unavailable
              </Button>
            </>
          )}
          <div class="af-session-composer-row">
            {item.approval.availableDecisions.map((decision) => (
              <Button
                key={decision}
                disabled={
                  !actionable ||
                  !view.actionable ||
                  held ||
                  view.posting ||
                  view.checking ||
                  view.loading
                }
                onClick={() => {
                  if (actionable)
                    void client.decide(item.approval.id, decision);
                }}
              >
                {choices[decision]}
              </Button>
            ))}
          </div>
          <p class="af-session-note">
            A recorded decision confirms private intent only. Native delivery
            and execution are reported separately.
          </p>
        </article>
      ))}
    </section>
  );
}
