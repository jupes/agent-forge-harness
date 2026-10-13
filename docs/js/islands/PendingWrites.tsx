import type { JSX } from "preact";
import { Button } from "../ds/Button";
import { applied, type Unsettled, useNotices } from "./bead-writes";

/** The id of the page's list of writes to check; a view points to it. */
const LIST_ID = "af-writes-to-check";

/** What a notice is about: the action and the bead, or a create and its title. */
function subject(attempt: Unsettled): string {
  return attempt.action === "create"
    ? `create "${attempt.title ?? ""}"`
    : `${attempt.action} on ${attempt.id ?? ""}`;
}

/**
 * One write the operator should check: its outcome is not known (the change
 * may have been made), or it was refused while no view of it was there. It
 * comes from the page's store, so it is said whatever a card or panel shows,
 * after the view that sent it is gone and after a reload, until dismissed.
 */
function WriteNotice({ attempt }: { attempt: Unsettled }): JSX.Element {
  const unknown = attempt.outcome === "unknown";
  const target =
    attempt.action === "create"
      ? `"${attempt.title ?? ""}"`
      : (attempt.id ?? "");
  return (
    <div class="af-bead-unsettled">
      <p
        class="af-review-result af-bead-result is-error"
        data-outcome={attempt.outcome}
      >
        {unknown
          ? `Outcome not known (${subject(attempt)}). ${attempt.message}`
          : `Refused (${subject(attempt)}): ${attempt.message}`}
      </p>
      <div class="af-button-row">
        <Button
          variant="ghost"
          aria-label={`Dismiss the ${attempt.action} notice for ${target}`}
          onClick={() => applied.dismiss(attempt.key)}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/**
 * Every bead write the page has to report and no view is sure to show: on
 * every route, above the route's own content. The live region is always
 * there, so a notice added to it is announced.
 */
export function PendingWrites(): JSX.Element {
  const notices = useNotices();
  return (
    <div class="af-writes-to-check-live" role="status" aria-live="polite">
      {notices.length > 0 ? (
        <section
          id={LIST_ID}
          class="af-writes-to-check"
          aria-labelledby={`${LIST_ID}-title`}
          tabIndex={-1}
        >
          <h2 id={`${LIST_ID}-title`} class="af-section-label">
            Writes to check
          </h2>
          {notices.map((attempt) => (
            <WriteNotice key={attempt.key} attempt={attempt} />
          ))}
        </section>
      ) : null}
    </div>
  );
}

/**
 * Where a write was sent from: one line pointing to the list while a write
 * this view sent is a notice there. It goes when the notice is dismissed.
 */
export function NoticePointer({
  sent,
}: {
  sent: ReadonlySet<string>;
}): JSX.Element | null {
  const notices = useNotices();
  const mine = notices.find((attempt) => sent.has(attempt.key));
  if (mine === undefined) return null;
  return (
    <p class="af-muted af-bead-pointer">
      {mine.outcome === "unknown" ? "Outcome not known" : "Refused"}: see Writes
      to check at the top of the page.{" "}
      <Button
        variant="ghost"
        aria-label="Show Writes to check"
        onClick={() => {
          const list = document.getElementById(LIST_ID);
          list?.scrollIntoView({ block: "start" });
          list?.focus();
        }}
      >
        Show
      </Button>
    </p>
  );
}
