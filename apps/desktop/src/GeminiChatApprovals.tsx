import { Button } from "../../../docs/js/ds/Button";
import type { GeminiChatDecisions } from "./gemini-chat-decisions";

/** Only this protected live page supplies actions. Saved native permission frames remain data. */
export function GeminiChatApprovals({
  client,
  actionable,
}: {
  client: Pick<
    GeminiChatDecisions,
    "view" | "refreshPending" | "checkOriginal" | "decide"
  >;
  actionable: boolean;
}) {
  const view = client.view();
  if (!view) return null;
  const held = !!view.identity || !!view.identityError;
  const disabled =
    !actionable ||
    !view.actionable ||
    held ||
    view.posting ||
    view.checking ||
    view.loading;
  return (
    <section
      class="af-session-approvals"
      aria-label="Native Gemini permissions"
    >
      <div class="af-session-composer-row">
        <h3>Native permissions</h3>
        <Button
          disabled={!actionable || view.loading || view.posting}
          onClick={() => {
            void client.refreshPending();
          }}
        >
          Refresh native permissions
        </Button>
      </div>
      {view.loading && <p role="status">Checking live native requests…</p>}
      {view.error && <p role="alert">{view.error}</p>}
      {view.identityError && <p role="alert">{view.identityError}</p>}
      {view.notice && <p role="status">{view.notice}</p>}
      {view.identity && (
        <div class="af-session-warning">
          <p>
            An original decision is held. No replacement will be sent. Private
            permission details are not stored in this browser.
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
            ? "No verified native permission is waiting."
            : "There is no live permission control for this turn."}
        </p>
      )}
      {view.pending.map(({ approval }) => (
        <article
          key={approval.id}
          class="af-session-approval"
          aria-label="Native Gemini permission request"
        >
          <h4>Native tool permission</h4>
          <pre>
            {approval.detail.json}
            {approval.detail.truncated ? " (truncated)" : ""}
          </pre>
          {!approval.detailsComplete && (
            <p class="af-session-warning">
              Complete native details are unavailable. Allow choices are
              unavailable.
            </p>
          )}
          <div class="af-session-composer-row">
            {approval.options.map((option) => (
              <Button
                key={option.optionId}
                disabled={disabled}
                onClick={() => {
                  if (actionable)
                    void client.decide(approval.id, option.optionId);
                }}
              >
                {option.name}
              </Button>
            ))}
            <Button
              disabled={disabled}
              onClick={() => {
                if (actionable) void client.decide(approval.id, null);
              }}
            >
              Cancel native request
            </Button>
          </div>
          <p class="af-session-note">
            A recorded decision confirms private intent only. Native delivery
            and execution are reported separately. Only the provider’s offered
            one-time choices are available.
          </p>
        </article>
      ))}
    </section>
  );
}
