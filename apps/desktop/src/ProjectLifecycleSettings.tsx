import { useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import type { ProjectRecord } from "../../../types/projects";
import type { useProjectLifecycle } from "./use-project-lifecycle";
import type { useProjectValueSettings } from "./use-project-value-settings";

export function ProjectLifecycleSettings({
  id,
  project,
  writesAllowed,
  archive,
  lifecycle,
}: {
  id: string;
  project: ProjectRecord | null;
  writesAllowed: boolean;
  archive: ReturnType<typeof useProjectValueSettings<boolean>>;
  lifecycle: ReturnType<typeof useProjectLifecycle>;
}) {
  const [confirmation, setConfirmation] = useState({ id, text: "" }),
    text = confirmation.id === id ? confirmation.text : "";
  const archived = archive.projects[id],
    receipt = lifecycle.receipts[id],
    pending = lifecycle.pending[id],
    status = lifecycle.statuses[id],
    savedArchived = archived?.catalog?.value;
  const editable =
    writesAllowed && !archive.busy && !lifecycle.busy && !pending && !receipt;
  return (
    <section
      class="af-project-keeper"
      aria-labelledby="project-lifecycle-heading"
    >
      <h3 id="project-lifecycle-heading">Archive or delete project</h3>
      <p>
        Archive prevents new project sessions, turns and Shifts. Existing work
        and Stop remain available. Delete removes only the project record after
        project sessions, Shifts and other saved action owners are settled.
        Repositories, beads, worktrees and provider histories are retained.
      </p>
      {project && (
        <>
          <p>
            Saved archive preference:{" "}
            {savedArchived === undefined
              ? "unavailable"
              : savedArchived
                ? "archived"
                : "active"}{" "}
            · catalog revision {archived?.catalog?.revision ?? "unavailable"}.
          </p>
          {archived?.message && <p role="status">{archived.message}</p>}
          <Button
            disabled={Boolean(archive.busy)}
            onClick={() => void archive.owner.review(id)}
          >
            Check current archive preference
          </Button>
          {archived?.needsReview && archived.checked && (
            <Button
              disabled={!editable}
              onClick={() => archive.owner.confirmReview(id)}
            >
              I reviewed the current archive preference
            </Button>
          )}
          <Button
            disabled={!editable || !archived?.catalog || archived.needsReview}
            onClick={() => {
              archive.owner.edit(id, !archived!.catalog!.value);
              void archive.owner.save(id);
            }}
          >
            {savedArchived === undefined
              ? "Archive preference unavailable"
              : savedArchived
                ? "Unarchive project"
                : "Archive project"}
          </Button>
        </>
      )}
      <p role="status" aria-live="polite">
        {lifecycle.messageProjectId === id || lifecycle.storageError
          ? lifecycle.message
          : ""}
      </p>
      {receipt ? (
        <p>
          Deleted {receipt.name} · revision {receipt.deletedRevision} ·{" "}
          <time dateTime={receipt.deletedAt}>
            {new Date(receipt.deletedAt).toLocaleString()}
          </time>
          . Original UUID: <code>{receipt.requestId}</code>.
        </p>
      ) : (
        <>
          <Button
            disabled={Boolean(lifecycle.busy) || lifecycle.storageError}
            onClick={() => void lifecycle.owner.check(id)}
          >
            {pending
              ? "Check original deletion receipt"
              : "Check deletion eligibility"}
          </Button>
          {status && (
            <p>
              Checked{" "}
              <time dateTime={status.asOf}>
                {new Date(status.asOf).toLocaleString()}
              </time>{" "}
              · revision {status.catalogRevision} · {status.state}.{" "}
              {status.reasons.join(" ")}
            </p>
          )}
          {project && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  editable &&
                  savedArchived === true &&
                  status?.state === "eligible" &&
                  text === project.name
                )
                  void lifecycle.owner.remove(id, text);
              }}
            >
              <label>
                Type the project name to confirm deletion
                <input
                  aria-label="Project name to confirm deletion"
                  value={text}
                  disabled={!editable || savedArchived !== true}
                  autoComplete="off"
                  onInput={(event) =>
                    setConfirmation({ id, text: event.currentTarget.value })
                  }
                />
              </label>
              <p>
                Type exactly: <strong>{project.name}</strong>. Active or unknown
                work refuses deletion; this action does not stop anything.
              </p>
              <button
                class="af-btn"
                type="submit"
                disabled={
                  !editable ||
                  savedArchived !== true ||
                  status?.state !== "eligible" ||
                  text !== project.name
                }
              >
                Delete project record
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
