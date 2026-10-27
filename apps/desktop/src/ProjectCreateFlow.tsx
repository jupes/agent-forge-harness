import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Dialog } from "../../../docs/js/ds/Dialog";
import type { ProjectScopePreview } from "../../../scripts/projects/create-options-protocol";
import { projectCreateOriginalSchema } from "../../../scripts/projects/create-protocol";
import { PROJECT_COLOR_IDS } from "../../../types/projects";
import type {
  createProjectCreateOwner,
  ProjectCreateEntry,
  ProjectCreateState,
} from "./project-create-owner";
import { openProject } from "./projects-model";

type Owner = ReturnType<typeof createProjectCreateOwner>;
type Draft = {
  slug: string;
  name: string;
  description: string;
  icon: string;
  keeperSmith: string;
  color: string;
  repositories: string[];
  epicIds: string[];
};
const emptyDraft = (): Draft => ({
  slug: "",
  name: "",
  description: "",
  icon: "",
  keeperSmith: "",
  color: "",
  repositories: [],
  epicIds: [],
});

function originalFromDraft(state: ProjectCreateState, draft: Draft) {
  const options = state.options;
  if (!options) throw Error("Trusted project options are unavailable.");
  return projectCreateOriginalSchema.parse({
    slug: draft.slug.trim(),
    name: draft.name.trim(),
    description: draft.description,
    icon: draft.icon.trim(),
    keeperSmith: draft.keeperSmith,
    color: draft.color,
    workspaces: [
      {
        root: options.workspace.path,
        repositories: [...draft.repositories],
        epicIds: [...draft.epicIds],
      },
    ],
  });
}

function CreateProjectDialog({
  open,
  state,
  owner,
  close,
}: {
  open: boolean;
  state: ProjectCreateState;
  owner: Owner;
  close(): void;
}): JSX.Element {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [reviewed, setReviewed] = useState<{
    original: ReturnType<typeof originalFromDraft>;
    preview: ProjectScopePreview;
  } | null>(null);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const options = state.options;
  const smiths = state.smiths?.smiths.filter((smith) => smith.enabled) ?? [];
  const field = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setReviewed(null);
    setError("");
  };
  const reviewScope = async () => {
    setError("");
    let original: ReturnType<typeof originalFromDraft>;
    try {
      original = originalFromDraft(state, draft);
      if (!draft.keeperSmith || !draft.color)
        throw Error("Select an enabled Keeper and a project color.");
      if (!draft.repositories.length || !draft.epicIds.length)
        throw Error("Select at least one trusted repository and epic.");
      if (!smiths.some((smith) => smith.name === draft.keeperSmith))
        throw Error("Select an enabled configured Keeper.");
    } catch {
      setError(
        "Complete the project fields and choose only the current trusted workspace, repository, epic, Keeper, and color options.",
      );
      return;
    }
    setWorking(true);
    try {
      const preview = await owner.preview(original);
      if (!preview) {
        setError(
          owner.get().error || "The project scope could not be verified.",
        );
        return;
      }
      setReviewed({ original: structuredClone(original), preview });
    } finally {
      setWorking(false);
    }
  };
  const reserve = async () => {
    if (!reviewed || working) return;
    setWorking(true);
    try {
      const confirmed = await owner.reserve(
        structuredClone(reviewed.original),
        structuredClone(reviewed.preview),
      );
      if (confirmed) {
        close();
        return;
      }
      const held = owner
        .get()
        .entries.some(
          (entry) => entry.original.slug === reviewed.original.slug,
        );
      if (held) close();
      else
        setError(owner.get().error || "The original remains held for review.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog
      open={open}
      class="af-project-create-dialog"
      title={reviewed ? "Review project original" : "Create a project"}
      titleId="af-project-create-title"
      onClose={close}
      actions={
        reviewed ? (
          <>
            <Button
              disabled={working || state.busy}
              onClick={() => setReviewed(null)}
            >
              Edit project
            </Button>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              disabled={working || state.busy || !options}
              onClick={() => void reserve()}
            >
              Reserve reviewed original
            </Button>
          </>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              disabled={working || state.busy || !options || !smiths.length}
              onClick={() => void reviewScope()}
            >
              Review trusted project scope
            </Button>
          </>
        )
      }
    >
      {error && <p role="alert">{error}</p>}
      {state.error && <p role="status">{state.error}</p>}
      {state.busy && <p role="status">{state.notice}</p>}
      {!options ? (
        <>
          <p role="status">Trusted project choices are unavailable.</p>
          <Button disabled={state.busy} onClick={() => void owner.recover()}>
            Refresh trusted choices
          </Button>
        </>
      ) : reviewed ? (
        <>
          <p>
            This exact original is reviewed before a reservation is saved. No
            project is created and no Keeper conversation starts at this step.
          </p>
          <dl class="af-project-create-original">
            <dt>Name</dt>
            <dd>{reviewed.original.name}</dd>
            <dt>Slug</dt>
            <dd>{reviewed.original.slug}</dd>
            <dt>Description</dt>
            <dd>{reviewed.original.description || "No description"}</dd>
            <dt>Icon</dt>
            <dd>{reviewed.original.icon}</dd>
            <dt>Keeper</dt>
            <dd>{reviewed.original.keeperSmith}</dd>
            <dt>Color</dt>
            <dd>{reviewed.original.color}</dd>
            <dt>Workspace</dt>
            <dd>{reviewed.original.workspaces[0]?.root}</dd>
            <dt>Repositories</dt>
            <dd>{reviewed.original.workspaces[0]?.repositories.join(", ")}</dd>
            <dt>Epics</dt>
            <dd>{reviewed.original.workspaces[0]?.epicIds.join(", ")}</dd>
            <dt>Current scope</dt>
            <dd>
              {reviewed.preview.scopeCount} items · {reviewed.preview.scopeHash}
            </dd>
          </dl>
        </>
      ) : (
        <>
          <p>
            Project choices come from the current trusted workspace and enabled
            Keepers. Only Reserve saves this exact original; Create is a
            separate reviewed action.
          </p>
          <label>
            Project name
            <input
              aria-label="Project name"
              maxLength={120}
              value={draft.name}
              onInput={(event) => field("name", event.currentTarget.value)}
            />
          </label>
          <label>
            Project slug
            <input
              aria-label="Project slug"
              maxLength={48}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              value={draft.slug}
              onInput={(event) => field("slug", event.currentTarget.value)}
            />
          </label>
          <label>
            Description
            <textarea
              aria-label="Project description"
              maxLength={500}
              value={draft.description}
              onInput={(event) =>
                field("description", event.currentTarget.value)
              }
            />
          </label>
          <label>
            Icon character
            <input
              aria-label="Project icon"
              maxLength={16}
              value={draft.icon}
              onInput={(event) => field("icon", event.currentTarget.value)}
            />
          </label>
          <label>
            Keeper
            <select
              aria-label="Project Keeper"
              value={draft.keeperSmith}
              onChange={(event) =>
                field("keeperSmith", event.currentTarget.value)
              }
            >
              <option value="">Choose an enabled Keeper</option>
              {smiths.map((smith) => (
                <option key={smith.name} value={smith.name}>
                  {smith.name} · {smith.provider} · {smith.model}
                </option>
              ))}
            </select>
          </label>
          <label>
            Project color
            <select
              aria-label="Project color"
              value={draft.color}
              onChange={(event) => field("color", event.currentTarget.value)}
            >
              <option value="">Choose a color</option>
              {PROJECT_COLOR_IDS.map((color) => (
                <option key={color} value={color}>
                  {color}
                </option>
              ))}
            </select>
          </label>
          <fieldset>
            <legend>Repositories in {options.workspace.path}</legend>
            {options.repositories.map((repository) => (
              <label key={repository.key}>
                <input
                  type="checkbox"
                  checked={draft.repositories.includes(repository.path)}
                  onChange={(event) =>
                    field(
                      "repositories",
                      event.currentTarget.checked
                        ? [...draft.repositories, repository.path]
                        : draft.repositories.filter(
                            (path) => path !== repository.path,
                          ),
                    )
                  }
                />
                {repository.name} · {repository.path}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Epics</legend>
            {options.epics.map((epic) => (
              <label key={epic.id}>
                <input
                  type="checkbox"
                  checked={draft.epicIds.includes(epic.id)}
                  onChange={(event) =>
                    field(
                      "epicIds",
                      event.currentTarget.checked
                        ? [...draft.epicIds, epic.id]
                        : draft.epicIds.filter((id) => id !== epic.id),
                    )
                  }
                />
                {epic.title} · {epic.id}
              </label>
            ))}
          </fieldset>
        </>
      )}
    </Dialog>
  );
}

function SavedOriginalDialog({
  entry,
  owner,
  canWrite,
  close,
}: {
  entry: ProjectCreateEntry | null;
  owner: Owner;
  canWrite: boolean;
  close(): void;
}): JSX.Element {
  const [retiring, setRetiring] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const original = entry?.original;
  const identity = entry?.identity;
  const requestId = identity?.requestId ?? entry?.local?.request.requestId;
  const requestHash = identity?.requestHash ?? entry?.local?.requestHash;
  const commit = async () => {
    if (!requestId) return;
    setWorking(true);
    try {
      const projectId = await owner.commit(requestId);
      if (projectId) {
        window.location.hash = openProject(projectId);
        return;
      }
      setMessage(owner.get().notice);
    } finally {
      setWorking(false);
    }
  };
  const check = async () => {
    if (!requestId) return;
    setWorking(true);
    try {
      await owner.checkOriginal(requestId);
      setMessage(owner.get().notice);
    } finally {
      setWorking(false);
    }
  };
  const retry = async () => {
    if (!requestId) return;
    setWorking(true);
    try {
      await owner.retryReservation(requestId);
      setMessage(owner.get().notice);
    } finally {
      setWorking(false);
    }
  };
  const retire = async () => {
    if (!requestId) return;
    setWorking(true);
    try {
      await owner.retire(requestId);
      setMessage(owner.get().notice);
      if (
        !owner
          .get()
          .entries.some((item) => item.identity?.requestId === requestId)
      )
        close();
      setRetiring(false);
    } finally {
      setWorking(false);
    }
  };
  const reserved =
    entry?.phase === "reserved" && identity?.state === "reserved";
  return (
    <Dialog
      open={entry !== null}
      class="af-project-create-dialog"
      title="Review saved project original"
      titleId="af-project-create-review-title"
      onClose={close}
      actions={
        <>
          <Button onClick={close}>Close review</Button>
          {reserved && !retiring && (
            <>
              <Button
                disabled={working || !canWrite}
                onClick={() => setRetiring(true)}
              >
                Retire reserved original
              </Button>
              <Button
                variant="primary"
                disabled={working || !canWrite}
                onClick={() => void commit()}
              >
                Create project from this original
              </Button>
            </>
          )}
          {!identity && requestId && (
            <>
              <Button disabled={working} onClick={() => void check()}>
                Check saved original
              </Button>
              {entry?.phase === "not-sent" && (
                <Button
                  variant="primary"
                  disabled={working || !canWrite}
                  onClick={() => void retry()}
                >
                  Retry exact saved reservation
                </Button>
              )}
            </>
          )}
        </>
      }
    >
      {original && requestId && requestHash ? (
        <>
          <p>
            Only this exact saved original can continue. Checking is read-only;
            Create and Retire are separate explicit actions.
          </p>
          {entry?.phase === "not-sent" ? (
            <p role="status">
              The last reservation was refused before sending. Only this exact
              saved request can be retried.
            </p>
          ) : entry?.phase !== "reserved" ? (
            <p role="status">
              Reservation outcome is uncertain. The saved UUID and body remain
              held; a missing read does not authorize a replacement.
            </p>
          ) : null}
          {retiring ? (
            <div role="alertdialog" aria-label="Confirm project retirement">
              <p>
                Retire <strong>{original.name}</strong> ({requestId})? The
                original will remain in history and cannot be edited.
              </p>
              <Button onClick={() => setRetiring(false)}>Keep reserved</Button>
              <Button
                variant="primary"
                disabled={working || !canWrite}
                onClick={() => void retire()}
              >
                Confirm retirement
              </Button>
            </div>
          ) : (
            <dl class="af-project-create-original">
              <dt>Name</dt>
              <dd>{original.name}</dd>
              <dt>Description</dt>
              <dd>{original.description || "No description"}</dd>
              <dt>Slug</dt>
              <dd>{original.slug}</dd>
              <dt>Saved request</dt>
              <dd>{requestId}</dd>
              <dt>Original hash</dt>
              <dd>{requestHash}</dd>
              <dt>Workspace</dt>
              <dd>{original.workspaces[0]?.root}</dd>
              <dt>Repositories</dt>
              <dd>{original.workspaces[0]?.repositories.join(", ")}</dd>
              <dt>Epics</dt>
              <dd>{original.workspaces[0]?.epicIds.join(", ")}</dd>
              <dt>Keeper</dt>
              <dd>{original.keeperSmith ?? "Not selected"}</dd>
              <dt>Color</dt>
              <dd>{original.color ?? "default"}</dd>
              <dt>Server state</dt>
              <dd>{identity?.state ?? entry?.phase}</dd>
            </dl>
          )}
          {message && <p role="status">{message}</p>}
          {working && <p role="status">{owner.get().notice}</p>}
        </>
      ) : (
        <p role="status">
          This saved project original is not available for verified review.
        </p>
      )}
    </Dialog>
  );
}

export function ProjectCreateFlow({
  state,
  owner,
  canWrite,
}: {
  state: ProjectCreateState;
  owner: Owner;
  canWrite: boolean;
}): JSX.Element {
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId
    ? (state.entries.find(
        (entry) =>
          (entry.identity?.requestId ?? entry.local?.request.requestId) ===
          selectedId,
      ) ?? null)
    : null;
  const active = state.entries.filter(isActiveEntry);
  const canCreate = state.phase === "ready" && active.length === 0;
  return (
    <section aria-label="Project creation" class="af-project-create">
      <div class="af-project-new">
        <Button
          disabled={!canCreate || !canWrite || state.busy}
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
      {state.notice && <p role="status">{state.notice}</p>}
      {active.map((entry) => (
        <article
          class="af-project-create-reserved"
          key={entry.identity?.requestId ?? entry.local?.request.requestId}
        >
          <p>
            {entry.original.name} ·{" "}
            {entry.phase === "reserved" ? "Reserved" : "Needs review"}
          </p>
          <Button
            onClick={() =>
              setSelectedId(
                entry.identity?.requestId ??
                  entry.local?.request.requestId ??
                  null,
              )
            }
          >
            {entry.phase === "reserved"
              ? "Review reserved project"
              : "Review saved project"}
          </Button>
        </article>
      ))}
      <CreateProjectDialog
        open={createOpen}
        state={state}
        owner={owner}
        close={() => setCreateOpen(false)}
      />
      <SavedOriginalDialog
        entry={selected}
        owner={owner}
        canWrite={canWrite}
        close={() => setSelectedId(null)}
      />
    </section>
  );
}

function isActiveEntry(entry: ProjectCreateEntry) {
  return (
    entry.phase === "pending" ||
    entry.phase === "not-sent" ||
    entry.phase === "unknown" ||
    entry.phase === "reserved"
  );
}
