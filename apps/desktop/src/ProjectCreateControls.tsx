import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Dialog } from "../../../docs/js/ds/Dialog";
import type {
  ProjectCreateEntry,
  ProjectCreateState,
} from "./project-create-client";

function ReservedProjectReview({
  entry,
  close,
}: {
  entry: ProjectCreateEntry | null;
  close(): void;
}): JSX.Element {
  const original = entry?.original;
  const identity = entry?.identity;
  return (
    <Dialog
      open={entry !== null}
      title="Review saved project original"
      titleId="af-project-create-review-title"
      onClose={close}
      actions={<Button onClick={close}>Close review</Button>}
    >
      {original && identity ? (
        <>
          <p>
            This is the exact project original saved by the hearth. Reviewing it
            does not create a project or start a Keeper conversation.
          </p>
          <dl class="af-project-create-original">
            <dt>Name</dt>
            <dd>{original.name}</dd>
            <dt>Description</dt>
            <dd>{original.description || "No description"}</dd>
            <dt>Slug</dt>
            <dd>{original.slug}</dd>
            <dt>Saved request</dt>
            <dd>{identity.requestId}</dd>
            <dt>Original hash</dt>
            <dd>{identity.requestHash}</dd>
            <dt>Workspace</dt>
            <dd>{original.workspaces[0]?.root}</dd>
            <dt>Keeper</dt>
            <dd>{original.keeperSmith ?? "Not selected"}</dd>
          </dl>
        </>
      ) : (
        <p role="status">
          This saved project original is not available for verified review.
        </p>
      )}
    </Dialog>
  );
}

export function ProjectCreateControls({
  state,
  refresh,
  canWrite,
}: {
  state: ProjectCreateState;
  refresh(): Promise<void>;
  canWrite: boolean;
}): JSX.Element {
  const [createOpen, setCreateOpen] = useState(false);
  const [reviewEntry, setReviewEntry] = useState<ProjectCreateEntry | null>(
    null,
  );
  const reserved = state.entries.filter(
    (entry) => entry.identity.state === "reserved",
  );
  const available = state.phase === "ready" && reserved.length === 0;
  return (
    <section aria-label="Project creation" class="af-project-create">
      <div class="af-project-new">
        <Button
          disabled={!available || !canWrite}
          {...(state.phase === "unavailable"
            ? { title: "Project creation details could not be verified" }
            : {})}
          onClick={() => setCreateOpen(true)}
        >
          New project
        </Button>
      </div>
      {state.phase === "loading" && (
        <p role="status">Checking saved project creations…</p>
      )}
      {state.error && <p role="status">{state.error}</p>}
      {reserved.map((entry) => (
        <article
          class="af-project-create-reserved"
          key={entry.identity.requestId}
        >
          <p>A saved project creation is awaiting explicit review.</p>
          <Button onClick={() => setReviewEntry(entry)}>
            Review reserved project
          </Button>
        </article>
      ))}
      <Dialog
        open={createOpen}
        title="Create a project"
        titleId="af-project-create-title"
        onClose={() => setCreateOpen(false)}
        actions={<Button onClick={() => setCreateOpen(false)}>Cancel</Button>}
      >
        <p>
          Project creation uses trusted workspace, repository, epic, and Keeper
          choices. No project is created until its saved original is reviewed.
        </p>
        <Button onClick={() => void refresh()}>Refresh trusted choices</Button>
      </Dialog>
      <ReservedProjectReview
        entry={reviewEntry}
        close={() => setReviewEntry(null)}
      />
    </section>
  );
}
