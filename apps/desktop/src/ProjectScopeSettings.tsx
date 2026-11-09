import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { z } from "zod";
import { Button } from "../../../docs/js/ds/Button";
import { operatorPost, operatorRead } from "../../../docs/js/operator";
import { API_PREFIX } from "../../../scripts/hearth/paths";
import { hasDuplicateObjectKeys } from "../../../scripts/json-object-keys";
import { ProjectScopeOwner, scopeAggregate } from "./project-scope-client";

const envelope = z
  .object({ ok: z.literal(true), data: z.unknown(), error: z.null() })
  .strict();
async function data(response: Response) {
  const raw = await response.text();
  if (!response.ok || hasDuplicateObjectKeys(raw))
    throw Error("Scope request could not be verified.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Error("Scope response was incomplete.");
  }
  return envelope.parse(parsed).data;
}
export function ProjectScopeSettings({
  projectId,
  revision,
  writesAllowed,
  archived,
  onRefresh,
}: {
  projectId: string;
  revision: number | null;
  writesAllowed: boolean;
  archived: boolean;
  onRefresh(): unknown;
}) {
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const held = useRef<ProjectScopeOwner | null>(null);
  held.current ??= new ProjectScopeOwner(projectId, {
    read: async (path, signal) =>
      data(
        await operatorRead(
          API_PREFIX + path,
          { ...(signal ? { signal } : {}) },
          { maxBodyBytes: 1024 * 1024 },
        ),
      ),
    post: async (path, body) =>
      data(
        await operatorPost(API_PREFIX + path, body, { maxBodyBytes: 65536 }),
      ),
    readPending: () => {
      const raw = sessionStorage.getItem(
        "agent-forge-pending-scope-" + projectId,
      );
      if (raw === null) return null;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw Error("Invalid pending Scope metadata.");
      }
      return value;
    },
    writePending: (value) => {
      const key = "agent-forge-pending-scope-" + projectId;
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(value));
    },
    refreshHome: async () => refresh.current(),
  });
  const owner = held.current,
    [state, setState] = useState(owner.snapshot());
  useLayoutEffect(() => {
    const unsubscribe = owner.subscribe(setState);
    void owner.load();
    return () => {
      unsubscribe();
      owner.dispose();
    };
  }, [owner]);
  useLayoutEffect(() => {
    owner.observeRevision(revision);
    owner.setEnabled(writesAllowed);
    owner.setArchived(archived);
  }, [owner, revision, writesAllowed, archived]);
  const aggregate = scopeAggregate(state),
    editable = owner.canChange(),
    pending = state.pending;
  return (
    <section
      class="af-project-repositories"
      aria-labelledby="project-scope-heading"
      aria-busy={state.busy}
    >
      <h3 id="project-scope-heading">Scope</h3>
      <p>
        Choose epics for every registered workspace. Membership requires the
        project label and ancestry under a selected epic. Saved repository
        membership does not grant source access.
      </p>
      <p>
        Other sources require explicit native folder consent and an
        already-running Hearth in this app's private home. Read grants last for
        this launch; restarting either Hearth requires consent again.
      </p>
      {archived && (
        <p role="status">Unarchive this project before changing Scope.</p>
      )}
      {!writesAllowed && (
        <p role="status">Scope changes wait for a verified connection.</p>
      )}
      <Button disabled={state.busy} onClick={() => void owner.load()}>
        Refresh Scope sources
      </Button>
      {state.notice && (
        <p role="status" aria-live="polite">
          {state.notice}
        </p>
      )}
      {state.storageError && (
        <p role="alert">
          Pending action metadata is unavailable. Restore browser session
          storage and reload before changing Scope.
        </p>
      )}
      {pending && (
        <aside aria-label="Unresolved Scope action">
          <p>
            An exact{" "}
            {pending.kind === "save"
              ? "Scope Save"
              : pending.kind === "authorize"
                ? "source authorization"
                : "source revocation"}{" "}
            needs checking. Other changes remain held.
          </p>
          <Button
            disabled={
              state.busy ||
              !state.enabled ||
              state.storageError ||
              (pending.kind === "revoke" && archived)
            }
            onClick={() => void owner.check()}
          >
            {pending.kind === "revoke"
              ? "Retry exact revocation"
              : "Check exact action result"}
          </Button>
          {state.list && pending.controllerId !== state.list.controllerId && (
            <>
              <p>
                The receiving Hearth changed. The old original cannot be
                recovered here. Current Scope may match while original delivery
                remains unknown.
              </p>
              <Button
                disabled={state.busy || !state.enabled}
                onClick={() => owner.reviewNewController()}
              >
                Review current Scope after restart
              </Button>
            </>
          )}
        </aside>
      )}
      <p>
        <strong>
          Aggregate:{" "}
          {aggregate.count === null ? "Unknown" : aggregate.count + " beads"}
        </strong>
      </p>
      <p>{aggregate.reason}</p>
      {state.list && (
        <>
          <p>
            Catalog revision {state.list.catalogRevision}. Each count is a fresh
            observation from one source, rather than a simultaneous
            cross-workspace snapshot.
          </p>
          <div class="af-project-repositories-workspaces">
            {state.list.workspaces.map((row, index) => {
              const selected = state.drafts[row.workspaceRef] ?? [],
                choices = state.epics[row.workspaceRef],
                proof = state.previews[row.workspaceRef],
                missing = choices
                  ? selected.filter(
                      (id) => !choices.some((epic) => epic.id === id),
                    )
                  : [];
              return (
                <section
                  key={row.workspaceRef}
                  class="af-project-repositories-workspace"
                  aria-labelledby={"scope-workspace-" + index}
                >
                  <h4 id={"scope-workspace-" + index}>Workspace {index + 1}</h4>
                  <p style={{ overflowWrap: "anywhere" }}>
                    <code>{row.root}</code>
                  </p>
                  <p>
                    {row.authority === "served"
                      ? "Served workspace"
                      : row.authority === "authorized"
                        ? "Read access authorized for this launch"
                        : "Read access requires native consent"}
                  </p>
                  {row.authority !== "served" && (
                    <Button
                      disabled={
                        !editable ||
                        !state.list!.nativeAuthorizationAvailable ||
                        state.list!.remainingAuthorizationRequests === 0
                      }
                      onClick={() => void owner.authorize(row.workspaceRef)}
                    >
                      {row.authority === "authorized"
                        ? "Authorize source again…"
                        : "Authorize source…"}
                    </Button>
                  )}
                  {row.authority === "authorized" && (
                    <Button
                      disabled={!editable}
                      onClick={() => void owner.revoke(row.workspaceRef)}
                    >
                      Revoke source access
                    </Button>
                  )}
                  {row.authority !== "served" &&
                    !state.list!.nativeAuthorizationAvailable && (
                      <p role="status">
                        Native consent is unavailable in this host. Open the
                        desktop app to authorize this source.
                      </p>
                    )}
                  <p>
                    Current selection:{" "}
                    {selected.length ? selected.join(", ") : "No epic selected"}
                  </p>
                  <Button
                    disabled={!editable || row.authority === "not-authorized"}
                    onClick={() => void owner.preview(row.workspaceRef, true)}
                  >
                    Load epic choices
                  </Button>
                  {choices && (
                    <fieldset disabled={!editable}>
                      <legend>Epics for workspace {index + 1}</legend>
                      {choices.length === 0 && (
                        <p>
                          No epic choices are available in this complete source.
                        </p>
                      )}
                      {[
                        ...choices,
                        ...missing.map((id) => ({
                          id,
                          title: "Missing from current source",
                        })),
                      ].map((epic) => (
                        <label key={epic.id} style={{ display: "block" }}>
                          <input
                            type="checkbox"
                            checked={selected.includes(epic.id)}
                            onChange={(event) =>
                              owner.edit(
                                row.workspaceRef,
                                event.currentTarget.checked
                                  ? [...selected, epic.id]
                                  : selected.filter((id) => id !== epic.id),
                              )
                            }
                          />
                          {epic.title} <code>{epic.id}</code>
                        </label>
                      ))}
                    </fieldset>
                  )}
                  {selected.length === 0 && (
                    <p role="status">
                      Select at least one epic before saving Scope.
                    </p>
                  )}
                  {missing.length > 0 && (
                    <p role="alert">
                      Remove missing epic selections and select current epics
                      before previewing.
                    </p>
                  )}
                  {state.errors[row.workspaceRef] && (
                    <p role="alert">{state.errors[row.workspaceRef]}</p>
                  )}
                  {proof ? (
                    <>
                      <p>
                        Complete preview: {proof.scopeCount} beads, observed{" "}
                        <time dateTime={proof.sourceAsOf}>
                          {new Date(proof.sourceAsOf).toLocaleString()}
                        </time>
                        .
                      </p>
                      <p style={{ overflowWrap: "anywhere" }}>
                        Membership hash: <code>{proof.scopeHash}</code>
                      </p>
                    </>
                  ) : (
                    <p role="status">
                      Count, hash and freshness are unknown for this selection.
                    </p>
                  )}
                </section>
              );
            })}
          </div>
          <Button disabled={!editable} onClick={() => void owner.preview()}>
            Preview all workspace selections
          </Button>
          <Button disabled={!owner.canSave()} onClick={() => void owner.save()}>
            Save Scope
          </Button>
          <p>
            Save rechecks every source and the catalog revision. A failed or
            unavailable source holds the complete change.
          </p>
        </>
      )}
    </section>
  );
}
