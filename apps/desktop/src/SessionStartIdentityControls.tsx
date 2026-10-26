import { useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Dialog } from "../../../docs/js/ds/Dialog";
import type { OwnedSessionStartInput } from "../../../types/codex-owned-task";
import type { SessionStartIdentityMetadata } from "../../../types/session-start-identities";
import type { SessionProjectView } from "./session-client";

type IdentityView = Partial<
  Pick<
    SessionProjectView,
    | "identityPage"
    | "identityLoading"
    | "identityGeneration"
    | "startIdentityError"
    | "legacyIdentityError"
    | "legacyIdentityUnavailable"
    | "identityInspection"
    | "starting"
  >
>;

interface IdentityActions {
  refreshIdentities?(projectId: string): Promise<void> | undefined;
  inspectIdentity?(projectId: string, requestId: string): Promise<boolean>;
  retireIdentity?(projectId: string, requestId: string): Promise<boolean>;
  resumeStart?(
    projectId: string,
    request: OwnedSessionStartInput,
  ): Promise<void>;
}

export function SessionStartIdentityControls(props: {
  projectId: string;
  view: IdentityView;
  client: IdentityActions;
  request: OwnedSessionStartInput | null;
  writesAllowed: boolean;
  archived: boolean;
  onOpenOriginal?: ((sessionId: string) => void) | undefined;
}) {
  const [retiring, setRetiring] = useState<SessionStartIdentityMetadata | null>(
    null,
  );
  const page = props.view.identityPage;
  const unresolved =
    page?.identities.filter((identity) =>
      ["reserved", "not-sent"].includes(identity.state),
    ) ?? [];
  const confirmedRetirement = retiring
    ? page?.identities.find(
        (identity) =>
          identity.requestId === retiring.requestId &&
          identity.requestHash === retiring.requestHash &&
          identity.provider === retiring.provider &&
          identity.mode === retiring.mode &&
          identity.state === "reserved",
      )
    : undefined;
  const requestMatches = (identity: SessionStartIdentityMetadata) =>
    !!props.request &&
    ("provider" in props.request ? props.request.provider : "claude") ===
      identity.provider &&
    props.request.launch.mode === identity.mode;
  const canResume =
    unresolved.length === 1 &&
    !props.view.identityLoading &&
    typeof props.view.identityGeneration === "number" &&
    !!props.request &&
    !!props.client.resumeStart &&
    !props.view.startIdentityError &&
    !props.view.legacyIdentityError &&
    props.writesAllowed &&
    !props.archived &&
    !props.view.starting;
  const confirmRetirement = async () => {
    if (!retiring || !confirmedRetirement || !props.client.retireIdentity)
      return;
    const row = retiring;
    setRetiring(null);
    await props.client.retireIdentity(props.projectId, row.requestId);
  };

  return (
    <section class="af-start-identities" aria-label="Original Start requests">
      <header class="af-start-identities-header">
        <div>
          <h3>Original Start requests</h3>
          {page && (
            <p>
              {page.scope.projectId} · {page.scope.workspace}
            </p>
          )}
        </div>
        <Button
          disabled={
            !!props.view.identityLoading || !props.client.refreshIdentities
          }
          onClick={() => void props.client.refreshIdentities?.(props.projectId)}
        >
          {props.view.identityLoading ? "Checking…" : "Check server"}
        </Button>
      </header>

      {props.view.startIdentityError && (
        <p role="status" class="af-session-warning">
          {props.view.startIdentityError}
        </p>
      )}
      {props.view.legacyIdentityError && (
        <p role="status" class="af-session-warning">
          {props.view.legacyIdentityError} The local hint was kept unchanged.
        </p>
      )}
      {props.view.legacyIdentityUnavailable &&
        !props.view.legacyIdentityError && (
          <p role="status" class="af-session-warning">
            A previous local Start hint could not be read. Starting remains
            held.
          </p>
        )}
      {props.view.identityLoading && (
        <p role="status">Checking the server-owned identity page…</p>
      )}
      {!page &&
        !props.view.identityLoading &&
        !props.view.startIdentityError && (
          <p role="status">
            Waiting for a verified workspace and its server-owned identity page.
          </p>
        )}
      {page?.identities.length === 0 && !props.view.identityLoading && (
        <p>No server-owned Start identity is recorded for this workspace.</p>
      )}

      {page && page.identities.length > 0 && (
        <ul class="af-start-identities-list">
          {page.identities.map((identity) => {
            const isUnresolved = ["reserved", "not-sent"].includes(
              identity.state,
            );
            const inspection =
              props.view.identityInspection?.requestId === identity.requestId
                ? props.view.identityInspection
                : null;
            return (
              <li key={identity.requestId}>
                <div class="af-start-identity-details">
                  <strong>
                    {identity.provider} {identity.mode} · {identity.state}
                  </strong>
                  <code>{identity.requestId}</code>
                  <code>{identity.requestHash}</code>
                </div>
                <div class="af-start-identity-actions">
                  {isUnresolved && (
                    <Button
                      disabled={
                        !canResume ||
                        !requestMatches(identity) ||
                        unresolved[0]?.requestId !== identity.requestId
                      }
                      onClick={() =>
                        props.request &&
                        void props.client.resumeStart?.(
                          props.projectId,
                          props.request,
                        )
                      }
                    >
                      {identity.state === "not-sent"
                        ? "Retry exact original"
                        : "Continue exact original"}
                    </Button>
                  )}
                  {identity.state === "reserved" && (
                    <Button
                      disabled={
                        !props.writesAllowed ||
                        props.archived ||
                        !!props.view.identityLoading ||
                        props.view.identityGeneration == null ||
                        !!props.view.starting
                      }
                      onClick={() => setRetiring(identity)}
                    >
                      Review retirement
                    </Button>
                  )}
                  {["attempted", "admitted"].includes(identity.state) && (
                    <>
                      <Button
                        disabled={
                          !!props.view.identityLoading ||
                          props.view.identityGeneration == null ||
                          !props.client.inspectIdentity
                        }
                        onClick={() =>
                          void props.client.inspectIdentity?.(
                            props.projectId,
                            identity.requestId,
                          )
                        }
                      >
                        Inspect original
                      </Button>
                      {inspection?.state === "loading" && (
                        <span role="status">Verifying original…</span>
                      )}
                      {inspection?.state === "unavailable" && (
                        <span role="status">
                          Original unavailable; identity remains held.
                        </span>
                      )}
                      {inspection?.state === "verified" &&
                        inspection.sessionId && (
                          <span role="status">
                            Verified session {inspection.sessionId} ·{" "}
                            <a
                              href={`#/desktop/project/${encodeURIComponent(props.projectId)}/sessions?selectionKind=session&selectionId=${encodeURIComponent(inspection.sessionId)}`}
                              onClick={(event) => {
                                if (props.onOpenOriginal) {
                                  event.preventDefault();
                                  props.onOpenOriginal(inspection.sessionId!);
                                }
                              }}
                            >
                              Open original session
                            </a>
                          </span>
                        )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={retiring !== null}
        title="Retire this reserved Start?"
        onClose={() => setRetiring(null)}
        actions={
          <>
            <Button onClick={() => setRetiring(null)}>Keep reserved</Button>
            <Button
              variant="primary"
              disabled={
                !props.writesAllowed ||
                props.archived ||
                !confirmedRetirement ||
                !!props.view.identityLoading ||
                typeof props.view.identityGeneration !== "number" ||
                !!props.view.starting
              }
              onClick={() => void confirmRetirement()}
            >
              Retire this UUID
            </Button>
          </>
        }
      >
        {retiring && page && (
          <dl>
            <dt>Project and workspace</dt>
            <dd>
              {page.scope.projectId} · {page.scope.workspace}
            </dd>
            <dt>Provider and mode</dt>
            <dd>
              {retiring.provider} · {retiring.mode}
            </dd>
            <dt>UUID</dt>
            <dd>{retiring.requestId}</dd>
            <dt>Request hash</dt>
            <dd>{retiring.requestHash}</dd>
          </dl>
        )}
        <p>
          This permanently retires only this reserved UUID. The original prompt
          is not stored in this page. A fresh server read is required before a
          new Start can be enabled.
        </p>
      </Dialog>
    </section>
  );
}
