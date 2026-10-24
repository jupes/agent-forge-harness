import type { ProjectShiftView } from "./project-shift-client";

export type ShiftListRead = Pick<
  ProjectShiftView,
  "page" | "loading" | "error" | "identity"
>;

/** Presentation only: original identities and commands remain with the app-root client. */
export function ProjectShiftListStatus({ view }: { view: ShiftListRead }) {
  return (
    <>
      {(view.loading || (!view.page && !view.error)) && (
        <div class="af-shift-read-status">
          <p role="status" aria-live="polite">
            {view.page ? "Checking project shifts…" : "Loading project shifts…"}
          </p>
          {!view.page && (
            <div class="af-shift-row af-shift-skeleton" aria-hidden={true}>
              <i />
              <i />
              <i />
            </div>
          )}
        </div>
      )}
      {view.error && (
        <p role="alert">{view.error} Use Refresh shifts to check again.</p>
      )}
      {!view.loading &&
        !view.error &&
        view.page?.items.length === 0 &&
        !view.identity && <p>No project shifts reported.</p>}
    </>
  );
}
