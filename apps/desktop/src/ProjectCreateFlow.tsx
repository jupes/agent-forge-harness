import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Dialog } from "../../../docs/js/ds/Dialog";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import type { ProjectScopePreview } from "../../../scripts/projects/create-options-protocol";
import { projectCreateOriginalSchema } from "../../../scripts/projects/create-protocol";
import type {
  RepositoryClone,
  RepositorySelection,
} from "../../../scripts/projects/repository-onboarding-protocol";
import { projectRepositoryNameSchema } from "../../../scripts/projects/repository-onboarding-protocol";
import { PROJECT_COLOR_IDS } from "../../../types/projects";
import { createProjectCreateApi } from "./project-create-api";
import type {
  createProjectCreateOwner,
  ProjectCreateEntry,
  ProjectCreateState,
} from "./project-create-owner";
import { openProject } from "./projects-model";

type Owner = ReturnType<typeof createProjectCreateOwner>;
const repositoryApi = createProjectCreateApi({
  read: operatorRead,
  post: operatorPost,
});
const SELECTION_STORAGE = "agent-forge.project-repository-selection.v1";
const CLONE_STORAGE = "agent-forge.project-repository-clone.v1";
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
  const [repositoryWorking, setRepositoryWorking] = useState(false);
  const [repositoryNotice, setRepositoryNotice] = useState("");
  const [repositoryError, setRepositoryError] = useState("");
  const [selection, setSelection] = useState<RepositorySelection | null>(null);
  const [selectionId, setSelectionId] = useState<string | null>(null);
  const [selectionReviewed, setSelectionReviewed] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneReview, setCloneReview] = useState<RepositoryClone | null>(null);
  const [cloneId, setCloneId] = useState<string | null>(null);
  const options = state.options;
  const smiths = state.smiths?.smiths.filter((smith) => smith.enabled) ?? [];
  useEffect(() => {
    let active = true;
    const recover = async (key: string) => {
      let id: string | null = null;
      try {
        id = window.localStorage.getItem(key);
      } catch {
        if (active)
          setRepositoryNotice(
            "Saved repository requests are unavailable in this browser.",
          );
      }
      if (!id) return;
      if (key === SELECTION_STORAGE && active) setSelectionId(id);
      if (key === CLONE_STORAGE && active) setCloneId(id);
      try {
        if (key === SELECTION_STORAGE) {
          const saved = await repositoryApi.repositorySelection(id);
          if (active) {
            setSelection(saved);
            setFolderName(
              saved.path?.split(/[\\/]/).filter(Boolean).at(-1) ?? "",
            );
          }
        } else {
          const saved = await repositoryApi.repositoryClone(id);
          if (active) setCloneReview(saved);
        }
      } catch {
        if (active)
          setRepositoryNotice(
            "The saved repository request could not be recovered. It was not retried.",
          );
      }
    };
    void recover(SELECTION_STORAGE);
    void recover(CLONE_STORAGE);
    return () => {
      active = false;
    };
  }, []);
  const remember = (key: string, id: string | null) => {
    try {
      if (id) window.localStorage.setItem(key, id);
      else window.localStorage.removeItem(key);
      return true;
    } catch {
      setRepositoryError(
        "Browser storage is unavailable, so the request cannot be safely recovered.",
      );
      return false;
    }
  };
  const recoverSelection = async (id: string) => {
    try {
      const saved = await repositoryApi.repositorySelection(id);
      setSelection(saved);
      setSelectionId(id);
      if (saved.path)
        setFolderName(saved.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "");
      setSelectionReviewed(false);
      return saved;
    } catch {
      setRepositoryNotice(
        "The exact folder selection is not yet readable. Keep this request id and do not start another picker.",
      );
      return null;
    }
  };
  const pickRepositoryFolder = async () => {
    if (repositoryWorking) return;
    if (selection?.state === "selected") return;
    if (selectionId && (selection === null || selection.state === "unknown")) {
      setRepositoryWorking(true);
      await recoverSelection(selectionId);
      setRepositoryWorking(false);
      return;
    }
    setRepositoryError("");
    setRepositoryNotice("");
    const id = crypto.randomUUID();
    if (!remember(SELECTION_STORAGE, id)) return;
    setSelectionId(id);
    setRepositoryWorking(true);
    try {
      const result = await repositoryApi.pickRepository(id);
      if (result.state === "confirmed") {
        setSelection(result.value);
        if (result.value.path)
          setFolderName(
            result.value.path.split(/[\\/]/).filter(Boolean).at(-1) ?? "",
          );
        setSelectionReviewed(false);
        if (result.value.state === "unknown") await recoverSelection(id);
        else if (result.value.state === "rejected")
          setRepositoryNotice(
            "That folder was not confirmed as a Git repository root. Choose another folder to continue.",
          );
      } else if (result.state === "unknown") {
        await recoverSelection(id);
      } else {
        setRepositoryNotice(result.message);
      }
    } catch {
      setRepositoryError(
        "The folder selection request failed. Recover its saved UUID before starting another picker.",
      );
      await recoverSelection(id);
    } finally {
      setRepositoryWorking(false);
    }
  };
  const registerSelectedFolder = async () => {
    if (
      !selection ||
      selection.state !== "selected" ||
      !selection.path ||
      !selectionReviewed ||
      !projectRepositoryNameSchema.safeParse(folderName).success ||
      repositoryWorking
    )
      return;
    setRepositoryWorking(true);
    setRepositoryError("");
    setRepositoryNotice("");
    try {
      const result = await repositoryApi.registerRepository(
        selection,
        folderName,
      );
      if (result.state === "confirmed") {
        await owner.recover();
        setRepositoryNotice(
          "Repository registered. Choose it in the reviewed project scope.",
        );
        setSelection(null);
        setSelectionId(null);
        setSelectionReviewed(false);
        remember(SELECTION_STORAGE, null);
      } else {
        setRepositoryNotice(result.message);
        if (result.state === "unknown") {
          await owner.recover();
          setRepositoryNotice(
            "Registration outcome is not confirmed. The exact selection remains saved; repeat only this registration or recover it from trusted choices.",
          );
        }
      }
    } catch {
      setRepositoryError(
        "Registration could not be confirmed. Read the refreshed repository choices before trying the same saved selection again.",
      );
    } finally {
      setRepositoryWorking(false);
    }
  };
  const reserveRepositoryClone = async () => {
    if (
      repositoryWorking ||
      !projectRepositoryNameSchema.safeParse(cloneName).success
    )
      return;
    const id = cloneId ?? crypto.randomUUID();
    if (!remember(CLONE_STORAGE, id)) return;
    setCloneId(id);
    setRepositoryWorking(true);
    setRepositoryError("");
    setRepositoryNotice("");
    try {
      const result = await repositoryApi.reserveRepositoryClone(
        id,
        cloneName,
        cloneUrl,
      );
      if (result.state === "confirmed") setCloneReview(result.value);
      else {
        setRepositoryNotice(result.message);
        if (result.state === "unknown") {
          try {
            const saved = await repositoryApi.repositoryClone(id);
            setCloneReview(saved);
            const submittedUrl = new URL(cloneUrl).href;
            if (saved.state === "registered") {
              await owner.recover();
              remember(CLONE_STORAGE, null);
            }
            if (saved.name !== cloneName || saved.url !== submittedUrl) {
              setRepositoryNotice(
                "This UUID already holds a different saved clone review. Its exact details are shown; they were not replaced.",
              );
            }
          } catch {
            setRepositoryNotice(
              "The clone review outcome is unknown. Do not create another request until this UUID is recovered.",
            );
          }
        }
      }
    } catch {
      setRepositoryError(
        "The clone review could not be confirmed. Recover the saved UUID before creating another review.",
      );
    } finally {
      setRepositoryWorking(false);
    }
  };
  const executeRepositoryClone = async () => {
    if (!cloneReview || cloneReview.state !== "reserved" || repositoryWorking)
      return;
    setRepositoryWorking(true);
    setRepositoryError("");
    setRepositoryNotice("");
    try {
      const result = await repositoryApi.cloneRepository(cloneReview);
      let outcome = result.state === "confirmed" ? result.value : null;
      if (!outcome && result.state === "unknown") {
        try {
          outcome = await repositoryApi.repositoryClone(
            cloneReview.requestId,
            cloneReview,
          );
        } catch {
          setRepositoryNotice(
            "Clone outcome is unknown. The same clone was not retried.",
          );
        }
      }
      if (outcome) {
        setCloneReview(outcome);
        if (outcome.state === "registered") {
          await owner.recover();
          setRepositoryNotice(
            "Clone completed and the trusted repository choices were refreshed.",
          );
          remember(CLONE_STORAGE, null);
        } else if (outcome.state === "clone-complete") {
          setRepositoryNotice(
            "Clone completed. Confirm its repository registration to add it to trusted project choices.",
          );
        } else if (outcome.state === "failed") {
          setRepositoryNotice(
            "Clone failed. Any partial destination was left untouched; choose another name or add the folder after reviewing it.",
          );
        } else if (outcome.state === "unknown" || outcome.state === "running") {
          setRepositoryNotice(
            "Clone outcome is not confirmed. Review this saved request; it was not retried.",
          );
        }
      }
    } catch {
      setRepositoryError(
        "The clone request could not be confirmed. Its saved UUID was not retried.",
      );
    } finally {
      setRepositoryWorking(false);
    }
  };
  const recoverRepositoryClone = async () => {
    if (
      !cloneReview ||
      !["running", "unknown"].includes(cloneReview.state) ||
      repositoryWorking
    )
      return;
    setRepositoryWorking(true);
    setRepositoryError("");
    setRepositoryNotice("");
    try {
      const saved = await repositoryApi.repositoryClone(
        cloneReview.requestId,
        cloneReview,
      );
      setCloneReview(saved);
      if (saved.state === "registered") {
        await owner.recover();
        setRepositoryNotice(
          "Clone registration was read back and trusted repository choices were refreshed.",
        );
        remember(CLONE_STORAGE, null);
      } else if (saved.state === "clone-complete") {
        setRepositoryNotice(
          "Clone completion was read back. Review its registration before adding it to project choices.",
        );
      } else if (saved.state === "failed") {
        setRepositoryNotice(
          "The clone failed. Any partial destination remains untouched; review it before choosing another name.",
        );
      } else if (saved.state === "reserved") {
        setRepositoryNotice(
          "The saved review is still reserved. Confirm the clone action when ready.",
        );
      } else {
        setRepositoryNotice(
          "The exact clone request is still unresolved. It was not retried.",
        );
      }
    } catch {
      setRepositoryNotice(
        "The exact clone outcome is not readable yet. Keep this saved request; it was not retried.",
      );
    } finally {
      setRepositoryWorking(false);
    }
  };
  const registerCompletedClone = async () => {
    if (
      !cloneReview ||
      cloneReview.state !== "clone-complete" ||
      repositoryWorking
    )
      return;
    setRepositoryWorking(true);
    setRepositoryError("");
    setRepositoryNotice("");
    try {
      const result = await repositoryApi.registerClone(cloneReview);
      if (result.state === "confirmed") {
        await owner.recover();
        setCloneReview(result.value);
        setRepositoryNotice(
          "Clone registered. Choose it in the reviewed project scope.",
        );
        remember(CLONE_STORAGE, null);
      } else {
        setRepositoryNotice(result.message);
        try {
          const saved = await repositoryApi.repositoryClone(
            cloneReview.requestId,
            cloneReview,
          );
          setCloneReview(saved);
          if (saved.state === "registered") {
            await owner.recover();
            remember(CLONE_STORAGE, null);
          }
        } catch {
          setRepositoryError(
            "Registration outcome is unknown. Recover this same saved request; it will not be cloned again.",
          );
        }
      }
    } catch {
      setRepositoryError(
        "The confirmed clone could not be registered from its saved record.",
      );
    } finally {
      setRepositoryWorking(false);
    }
  };
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
            <legend>Add a repository</legend>
            <p>
              Adding a repository does not change this project until you select
              it above and review the scope.
            </p>
            <Button
              disabled={repositoryWorking || selection?.state === "selected"}
              onClick={() => void pickRepositoryFolder()}
            >
              {selection?.state === "unknown"
                ? "Recover folder selection"
                : selection?.state === "rejected"
                  ? "Choose another folder…"
                  : repositoryWorking && !selection
                    ? "Opening folder picker…"
                    : "Add a folder…"}
            </Button>
            {selection?.state === "cancelled" && (
              <p role="status">
                Folder selection cancelled. Nothing was registered.
              </p>
            )}
            {selection?.state === "unknown" && (
              <p role="status">
                Folder selection outcome is unknown. Recover this saved request
                before choosing again.
              </p>
            )}
            {selection?.state === "rejected" && (
              <p role="status">
                The selected folder was not confirmed as a Git repository root.
                You may choose another folder.
              </p>
            )}
            {selection?.state === "selected" && selection.path && (
              <>
                {!selectionReviewed ? (
                  <>
                    <label>
                      Repository name
                      <input
                        aria-label="Folder repository name"
                        maxLength={80}
                        value={folderName}
                        onInput={(event) => {
                          setFolderName(event.currentTarget.value);
                          setSelectionReviewed(false);
                        }}
                      />
                    </label>
                    <p>
                      Selected folder: <code>{selection.path}</code>
                    </p>
                    <Button
                      disabled={
                        repositoryWorking ||
                        !projectRepositoryNameSchema.safeParse(folderName)
                          .success
                      }
                      onClick={() => {
                        setRepositoryError("");
                        setSelectionReviewed(true);
                      }}
                    >
                      Review folder registration
                    </Button>
                  </>
                ) : (
                  <>
                    <dl>
                      <dt>Repository name</dt>
                      <dd>{folderName}</dd>
                      <dt>Canonical folder</dt>
                      <dd>
                        <code>{selection.path}</code>
                      </dd>
                    </dl>
                    <p>
                      Only this reviewed folder and name will be added. The
                      folder will not be copied or changed.
                    </p>
                    <Button
                      disabled={repositoryWorking}
                      onClick={() => setSelectionReviewed(false)}
                    >
                      Edit folder review
                    </Button>
                    <Button
                      variant="primary"
                      disabled={repositoryWorking}
                      onClick={() => void registerSelectedFolder()}
                    >
                      Register reviewed folder
                    </Button>
                  </>
                )}
              </>
            )}
            <hr />
            {!cloneReview ? (
              <>
                <label>
                  Clone URL
                  <input
                    aria-label="Repository clone URL"
                    type="url"
                    maxLength={2048}
                    value={cloneUrl}
                    onInput={(event) => setCloneUrl(event.currentTarget.value)}
                  />
                </label>
                <label>
                  Repository name
                  <input
                    aria-label="Clone repository name"
                    maxLength={80}
                    value={cloneName}
                    onInput={(event) => setCloneName(event.currentTarget.value)}
                  />
                </label>
                <p>
                  Only HTTPS URLs without embedded credentials or query data are
                  accepted. Reviewing a URL does not clone it.
                </p>
                <Button
                  disabled={
                    repositoryWorking ||
                    !projectRepositoryNameSchema.safeParse(cloneName).success ||
                    !cloneUrl.trim()
                  }
                  onClick={() => void reserveRepositoryClone()}
                >
                  Review clone destination
                </Button>
              </>
            ) : (
              <>
                <dl>
                  <dt>Clone status</dt>
                  <dd>{cloneReview.state}</dd>
                  <dt>Repository name</dt>
                  <dd>{cloneReview.name}</dd>
                  <dt>Source URL</dt>
                  <dd>
                    <code>{cloneReview.url}</code>
                  </dd>
                  <dt>Destination</dt>
                  <dd>
                    <code>{cloneReview.path}</code>
                  </dd>
                </dl>
                <p>
                  Clone runs only after this explicit confirmation. An existing
                  destination will never be overwritten or removed.
                </p>
                <Button
                  disabled={
                    repositoryWorking || cloneReview.state !== "reserved"
                  }
                  onClick={() => void executeRepositoryClone()}
                >
                  {repositoryWorking ? "Cloning…" : "Clone reviewed repository"}
                </Button>
                {["running", "unknown"].includes(cloneReview.state) && (
                  <Button
                    disabled={repositoryWorking}
                    onClick={() => void recoverRepositoryClone()}
                  >
                    Read saved clone status
                  </Button>
                )}
                {cloneReview.state === "clone-complete" && (
                  <Button
                    variant="primary"
                    disabled={repositoryWorking}
                    onClick={() => void registerCompletedClone()}
                  >
                    Register completed clone
                  </Button>
                )}
                {(cloneReview.state === "failed" ||
                  cloneReview.state === "registered") && (
                  <Button
                    disabled={repositoryWorking}
                    onClick={() => {
                      setCloneReview(null);
                      setCloneId(null);
                      setCloneName("");
                      setCloneUrl("");
                      remember(CLONE_STORAGE, null);
                    }}
                  >
                    Review another clone
                  </Button>
                )}
              </>
            )}
            {repositoryError && <p role="alert">{repositoryError}</p>}
            {repositoryNotice && <p role="status">{repositoryNotice}</p>}
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
  onCreated,
}: {
  entry: ProjectCreateEntry | null;
  owner: Owner;
  canWrite: boolean;
  close(): void;
  onCreated?:
    | ((created: { projectId: string; requestId: string }) => void)
    | undefined;
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
      const projectId = await owner.commit(requestId, onCreated);
      if (projectId) {
        if (!onCreated) window.location.hash = openProject(projectId);
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
  renderEntry,
  onCreated,
}: {
  state: ProjectCreateState;
  owner: Owner;
  canWrite: boolean;
  renderEntry?:
    | ((props: { disabled: boolean; onSkip(): void }) => JSX.Element)
    | undefined;
  onCreated?:
    | ((created: { projectId: string; requestId: string }) => void)
    | undefined;
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
  const disabled = !canCreate || !canWrite || state.busy;
  const openCreate = () => {
    if (!disabled) setCreateOpen(true);
  };
  const entryClass = renderEntry
    ? "af-project-new af-project-new-onboarding"
    : "af-project-new";
  return (
    <section aria-label="Project creation" class="af-project-create">
      <div class={entryClass}>
        {renderEntry ? (
          renderEntry({ disabled, onSkip: openCreate })
        ) : (
          <Button
            disabled={disabled}
            {...(state.phase === "unavailable"
              ? { title: "Project creation details could not be verified" }
              : {})}
            onClick={openCreate}
          >
            New project
          </Button>
        )}
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
        onCreated={onCreated}
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
