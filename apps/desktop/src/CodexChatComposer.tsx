import { useEffect, useRef, useState } from "preact/hooks";
import { actionOutcome } from "../../../docs/js/action-outcome";
import { Button } from "../../../docs/js/ds/Button";
import { operatorPost } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import { serializeCodexChat } from "../../../scripts/sessions/codex-app-server-protocol";
import { codexChatLaunchFromStart } from "../../../scripts/sessions/codex-chat-owned-preparation";
import { codexChatPreviewReceiptSchema } from "../../../scripts/sessions/codex-chat-preview-protocol";
import type { WorktreeEntry } from "../../../types/beads";
import type { CodexChatPreviewReceipt } from "../../../types/codex-chat-ui";
import type { SmithsView } from "../../../types/hearth";
import {
  chooseCodexChatSmith,
  codexChatStartBody,
  matchesCodexChatPreview,
} from "./codex-chat-composer";
import { providerUsageLabel, readinessLabel } from "./providers-model";
import type { SessionComposerProps } from "./SessionComposer";
import { chooseSessionSmith, sessionAttachments } from "./session-composer";

/** Native app-server Chat controls with a separately reviewed private initialization plan. */
export function CodexChatComposer({
  project,
  client,
  writesAllowed,
  onCancel,
  onStarted,
  providers,
}: SessionComposerProps) {
  const codexReadiness = providers?.providers.find(
      (provider) => provider.provider === "codex",
    ),
    claudeReadiness = providers?.providers.find(
      (provider) => provider.provider === "claude",
    );
  const view = client.project(project.id),
    draft = view.composer,
    options = view.codexChatComposer;
  const action = client.worktrees.get(project.id);
  const [settings, setSettings] = useState<{
    smiths: SmithsView;
    worktrees: WorktreeEntry[];
  } | null>(null);
  const [preview, setPreview] = useState<CodexChatPreviewReceipt | null>(null),
    [problem, setProblem] = useState("");
  const [checking, setChecking] = useState(false),
    [attaching, setAttaching] = useState(false);
  const prompt = useRef<HTMLTextAreaElement>(null),
    startAtOpen = useRef(view.lastStarted);
  const edit = (value: Partial<typeof draft>) =>
    client.editComposer(project.id, value);
  const editOptions = (value: Partial<typeof options>) =>
    client.editCodexChatComposer(project.id, value);
  useEffect(() => {
    let active = true;
    void Promise.all([
      readOperatorRoute<SmithsView>("/smiths", pageReads()),
      readOperatorRoute<WorktreeEntry[]>("/worktrees", pageReads()),
    ])
      .then(([smiths, worktrees]) => {
        if (!active) return;
        if (!Array.isArray(smiths.smiths) || !Array.isArray(worktrees))
          throw Error("Unverified choices");
        setSettings({ smiths, worktrees });
        const current = client.project(project.id);
        if (!current.composer.initialized) {
          const original = current.composer,
            selected = smiths.smiths.find(
              (smith) => smith.name === smiths.defaultSmith,
            );
          const preserved =
            selected?.enabled && selected.provider === "claude"
              ? chooseSessionSmith(original, selected)
              : original;
          client.editComposer(project.id, {
            ...preserved,
            initialized: true,
            repository:
              original.repository ||
              project.workspaces.flatMap((scope) => scope.repositories)[0] ||
              "",
            worktree:
              original.worktree ||
              worktrees.find((tree) => tree.kind === "main" && !tree.missing)
                ?.path ||
              "",
          });
        }
        if (!current.codexChatComposer.initialized) {
          const selected =
            smiths.smiths.find(
              (smith) =>
                smith.name === smiths.defaultSmith &&
                smith.enabled &&
                smith.provider === "codex",
            ) ??
            smiths.smiths.find(
              (smith) => smith.enabled && smith.provider === "codex",
            );
          editOptions(
            selected
              ? chooseCodexChatSmith(current.codexChatComposer, selected)
              : { initialized: true },
          );
        }
      })
      .catch(() => {
        if (active)
          setProblem(
            "Session choices could not be loaded. Reopen the composer to read them again.",
          );
      });
    prompt.current?.focus();
    return () => {
      active = false;
    };
  }, [project.id, client]);
  useEffect(() => {
    if (view.lastStarted && view.lastStarted !== startAtOpen.current)
      onStarted(view.lastStarted);
  }, [view.lastStarted, onStarted]);
  const snapshot = preview?.snapshot;
  const created =
    action.receipt?.state === "created" ? action.receipt.worktree : null;
  useEffect(() => {
    const original = action.original;
    if (
      created &&
      original &&
      draft.where === "new" &&
      draft.repository === original.repository &&
      draft.baseRef === original.baseRef &&
      draft.branch === original.branch &&
      (draft.beadId || undefined) === original.beadId &&
      draft.createdWorktree?.path !== created.path
    )
      edit({
        worktree: created.path,
        createdWorktree: {
          path: created.path,
          repository: original.repository,
          baseRef: original.baseRef,
          branch: original.branch,
          ...(original.beadId ? { beadId: original.beadId } : {}),
        },
      });
  }, [
    created?.path,
    action.original,
    draft.where,
    draft.repository,
    draft.baseRef,
    draft.branch,
    draft.beadId,
    draft.createdWorktree?.path,
  ]);
  const source = settings?.smiths.smiths.find(
    (smith) => smith.name === options.smith,
  );
  const main = settings?.worktrees.find(
    (tree) => tree.kind === "main" && !tree.missing,
  );
  const repositories = [
    ...new Set(project.workspaces.flatMap((scope) => scope.repositories)),
  ];
  const busy = checking || attaching || view.starting;
  const pending =
    !!view.pendingStart || !!view.startIdentity || !!view.startIdentityError;
  let validation =
    "Check supported options before starting. This check starts no model.";
  try {
    codexChatStartBody(draft, options);
  } catch (error) {
    validation =
      error instanceof Error ? error.message : "Review the Chat options.";
  }
  const serialized = matchesCodexChatPreview(
    project.id,
    draft,
    options,
    preview,
  )
    ? preview?.serialized
    : null;
  const canStart =
    writesAllowed &&
    !project.archived &&
    !busy &&
    !pending &&
    !!serialized &&
    source?.enabled === true &&
    source.provider === "codex";
  const start = () => {
    if (!canStart) return;
    try {
      void client.start(
        project.id,
        codexChatStartBody(
          client.project(project.id).composer,
          client.project(project.id).codexChatComposer,
        ),
      );
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "Review the selected Chat options.",
      );
    }
  };
  const check = async () => {
    if (busy || pending || !writesAllowed || project.archived) return;
    setChecking(true);
    setProblem("");
    try {
      const input = {
        ...codexChatStartBody(
          client.project(project.id).composer,
          client.project(project.id).codexChatComposer,
        ),
        requestId: crypto.randomUUID(),
      };
      const result = await actionOutcome(
        () =>
          operatorPost(
            `/__agent-forge/projects/${encodeURIComponent(project.id)}/sessions/preview`,
            input,
          ),
        "No session was started; check supported options again.",
      );
      if (result.state !== "done") throw Error(result.message);
      const checked = codexChatPreviewReceiptSchema.safeParse(result.data);
      if (
        !checked.success ||
        checked.data.projectId !== project.id ||
        checked.data.requestId !== input.requestId ||
        checked.data.snapshot.smith !== input.smith ||
        checked.data.snapshot.cwd !== input.worktree
      )
        throw Error("The preview did not match this original Chat request.");
      const expected = serializeCodexChat(
        codexChatLaunchFromStart(project.id, input),
        checked.data.snapshot.capabilities,
      );
      if (JSON.stringify(expected) !== JSON.stringify(checked.data.serialized))
        throw Error("The preview changed the reviewed Chat input.");
      setPreview(checked.data);
    } catch (error) {
      setPreview(null);
      setProblem(
        error instanceof Error
          ? error.message
          : "Chat options could not be checked.",
      );
    } finally {
      setChecking(false);
    }
  };
  const efforts =
    snapshot?.capabilities.modelEfforts?.find(
      (entry) =>
        entry.model === options.model &&
        entry.cliVersion === snapshot.capabilities.version,
    )?.efforts ?? [];
  return (
    <section
      class="af-session-composer"
      aria-label="New session composer"
      onKeyDown={(event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key === "Enter" &&
          !event.isComposing
        ) {
          event.preventDefault();
          start();
        }
      }}
    >
      <div
        class="af-session-provider-picker"
        role="group"
        aria-label="Provider"
      >
        <button
          type="button"
          aria-pressed="false"
          onClick={() => client.chooseComposerProvider(project.id, "claude")}
        >
          Cl · Claude
          <small>
            {claudeReadiness
              ? readinessLabel(claudeReadiness.state)
              : "Readiness not reported"}{" "}
            · {providerUsageLabel(claudeReadiness)}
          </small>
        </button>
        <button type="button" aria-pressed="true">
          Cx · Codex
          <small>
            Chat ·{" "}
            {codexReadiness
              ? readinessLabel(codexReadiness.state)
              : "Readiness not reported"}{" "}
            · {providerUsageLabel(codexReadiness)}
          </small>
        </button>
        {["Gemini", "Grok", "OpenRouter"].map((name) => (
          <button
            type="button"
            key={name}
            disabled
            title="Session adapter unavailable"
          >
            {name}
            <small>Session adapter unavailable</small>
          </button>
        ))}
      </div>
      <label>
        Prompt
        <textarea
          ref={prompt}
          aria-label="Session prompt"
          rows={5}
          maxLength={16_384}
          value={draft.prompt}
          onInput={(event) => edit({ prompt: event.currentTarget.value })}
        />
      </label>
      <div class="af-session-composer-row">
        <label>
          Attach text
          <input
            type="file"
            multiple
            accept="text/*,.md,.txt,.json,.yaml,.toml"
            disabled={attaching || pending}
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              setAttaching(true);
              void sessionAttachments(files)
                .then((items) => {
                  if (items.some((item) => item.kind !== "text"))
                    throw Error(
                      "Images require server-owned staging and are unavailable for Codex Chat.",
                    );
                  edit({
                    attachments: [
                      ...client.project(project.id).composer.attachments,
                      ...items,
                    ],
                  });
                })
                .catch((error) =>
                  setProblem(
                    error instanceof Error
                      ? error.message
                      : "Text could not be attached.",
                  ),
                )
                .finally(() => setAttaching(false));
            }}
          />
        </label>
        <span>
          Images and output schemas · unavailable until safe staging is
          supported
        </span>
      </div>
      <div class="af-session-chips">
        {draft.attachments.map((item, index) => (
          <span key={`${item.name}:${index}`}>
            {item.name}
            <button
              type="button"
              aria-label={`Remove attachment ${item.name}`}
              onClick={() =>
                edit({
                  attachments: draft.attachments.filter(
                    (_, at) => at !== index,
                  ),
                })
              }
            >
              ×
            </button>
          </span>
        ))}
        {draft.about.map((item) => (
          <span key={`${item.kind}:${item.id}`}>
            About {item.kind} {item.id}
            <button
              type="button"
              aria-label={`Remove ${item.kind} ${item.id} context`}
              onClick={() =>
                edit({ about: draft.about.filter((value) => value !== item) })
              }
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <fieldset>
        <legend>Context</legend>
        <div class="af-session-composer-row">
          <label>
            Repository
            <select
              aria-label="Session repository"
              value={draft.repository}
              disabled={!settings}
              onChange={(event) =>
                edit({ repository: event.currentTarget.value })
              }
            >
              {repositories.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </label>
          <label>
            Where it runs
            <select
              aria-label="Where the session runs"
              value={draft.where}
              onChange={(event) => {
                const where =
                  event.currentTarget.value === "new"
                    ? "new"
                    : event.currentTarget.value === "existing"
                      ? "existing"
                      : "main";
                edit({
                  where,
                  ...(where === "main" && main ? { worktree: main.path } : {}),
                });
              }}
            >
              <option value="new">New worktree (recommended)</option>
              <option value="existing">Existing worktree</option>
              <option value="main">Main checkout</option>
            </select>
          </label>
        </div>
        {draft.where === "main" ? (
          <p class="af-session-warning">
            Workspace writes land in your working copy.
          </p>
        ) : draft.where === "existing" ? (
          <label>
            Registered worktree
            <select
              aria-label="Registered session worktree"
              value={draft.worktree}
              onChange={(event) =>
                edit({ worktree: event.currentTarget.value })
              }
            >
              <option value="">Choose a registered worktree…</option>
              {settings?.worktrees
                .filter((tree) => !tree.missing)
                .map((tree) => (
                  <option key={tree.path} value={tree.path}>
                    {tree.branch ?? "Detached"} · {tree.path}
                  </option>
                ))}
            </select>
          </label>
        ) : (
          <div class="af-session-new-worktree">
            <p>
              Create a branch and directory explicitly before Preview or Start.
              This starts no provider.
            </p>
            <div class="af-session-composer-row">
              <label>
                Base ref
                <input
                  aria-label="New session worktree base ref"
                  value={draft.baseRef}
                  onInput={(event) =>
                    edit({ baseRef: event.currentTarget.value })
                  }
                />
              </label>
              <label>
                New branch
                <input
                  aria-label="New session worktree branch"
                  value={draft.branch}
                  onInput={(event) =>
                    edit({ branch: event.currentTarget.value })
                  }
                />
              </label>
            </div>
            {action.receipt?.worktree && (
              <p>
                Requested worktree: {action.receipt.worktree.path} ·{" "}
                {action.receipt.state === "created"
                  ? "Created"
                  : "Outcome unconfirmed; this path cannot start a session"}
              </p>
            )}
            {action.notice && <p role="status">{action.notice}</p>}
            {!action.original ? (
              <Button
                disabled={
                  !writesAllowed ||
                  project.archived ||
                  action.posting ||
                  pending
                }
                onClick={() => {
                  void client.worktrees.create(project.id, {
                    repository: draft.repository,
                    baseRef: draft.baseRef,
                    branch: draft.branch,
                    ...(draft.beadId ? { beadId: draft.beadId } : {}),
                  });
                }}
              >
                Create worktree
              </Button>
            ) : action.receipt && action.receipt.state !== "unknown" ? (
              <Button
                disabled={action.posting || action.checking}
                onClick={() => {
                  client.worktrees.another(project.id);
                  edit({ createdWorktree: null, worktree: "" });
                }}
              >
                Prepare another worktree
              </Button>
            ) : (
              <>
                <Button
                  disabled={action.checking}
                  onClick={() => {
                    void client.worktrees.check(project.id);
                  }}
                >
                  Check original worktree
                </Button>
                <Button
                  disabled={!writesAllowed || action.posting || pending}
                  onClick={() => {
                    void client.worktrees.retry(project.id);
                  }}
                >
                  Retry original worktree
                </Button>
              </>
            )}
          </div>
        )}
        <div class="af-session-composer-row">
          <label>
            Bead (optional)
            <input
              aria-label="Session bead"
              value={draft.beadId}
              onInput={(event) => edit({ beadId: event.currentTarget.value })}
            />
          </label>
          <label>
            Run as
            <select
              aria-label="Session mode"
              value="chat"
              onChange={(event) =>
                client.chooseCodexMode(
                  project.id,
                  event.currentTarget.value === "chat" ? "chat" : "task",
                )
              }
            >
              <option value="task">Task · one run, then ends</option>
              <option value="chat">
                Chat · native approvals and exact thread resume
              </option>
            </select>
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Codex options</legend>
        <label>
          Source smith
          <select
            aria-label="Session smith"
            value={options.smith}
            disabled={!settings}
            onChange={(event) => {
              const smith = settings?.smiths.smiths.find(
                (value) => value.name === event.currentTarget.value,
              );
              if (smith) editOptions(chooseCodexChatSmith(options, smith));
            }}
          >
            <option value="">Choose an enabled Codex smith</option>
            {settings?.smiths.smiths.map((smith) => (
              <option
                key={smith.name}
                value={smith.name}
                disabled={!smith.enabled || smith.provider !== "codex"}
              >
                {smith.name} · {smith.model}
                {smith.provider !== "codex"
                  ? " · different provider"
                  : !smith.enabled
                    ? " · disabled"
                    : ""}
              </option>
            ))}
          </select>
        </label>
        <div class="af-session-composer-row">
          <label>
            Requested model
            <input
              aria-label="Session model"
              maxLength={200}
              value={options.model}
              onInput={(event) =>
                editOptions({ model: event.currentTarget.value })
              }
            />
          </label>
          <label>
            Reasoning effort
            <select
              aria-label="Session effort"
              value={options.effort}
              onChange={(event) =>
                editOptions({ effort: event.currentTarget.value })
              }
            >
              <option value="">
                CLI default · explicitly leave effort unset
              </option>
              {options.effort && !efforts.includes(options.effort) && (
                <option value={options.effort} disabled>
                  {options.effort} · support unverified
                </option>
              )}
              {efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p>
          Model access is checked by the native server when Chat starts. Exact
          model effort support is not reported by help. An unverified configured
          effort stays selected until you explicitly change it.
        </p>
        <div class="af-session-composer-row">
          <label>
            Sandbox
            <select
              aria-label="Session sandbox"
              value={options.sandbox}
              onChange={(event) =>
                editOptions({
                  sandbox:
                    event.currentTarget.value === "workspace-write"
                      ? "workspace-write"
                      : "read-only",
                })
              }
            >
              <option value="read-only">Read only</option>
              <option value="workspace-write">Workspace write</option>
              <option disabled>
                Full access · unavailable in this Chat adapter
              </option>
            </select>
          </label>
          <label>
            Approvals
            <select
              aria-label="Session approvals"
              value={options.approvalPolicy}
              onChange={(event) =>
                editOptions({
                  approvalPolicy:
                    event.currentTarget.value === "never"
                      ? "never"
                      : "on-request",
                })
              }
            >
              <option value="on-request">
                On request · review native choices
              </option>
              <option value="never">Never · do not ask for approval</option>
              <option disabled>Automatic reviewer · unavailable</option>
              <option disabled>
                Bypass approvals and sandbox · locked by harness policy
              </option>
            </select>
          </label>
        </div>
        <p>
          Extra writable directories, profiles, MCP overrides and service tiers
          are unavailable in this adapter. Sign-in and remaining allowance are
          not reported by this check.
        </p>
      </fieldset>
      <footer class="af-session-preview">
        <h3>Native Chat initialization</h3>
        <Button
          disabled={
            !writesAllowed || project.archived || busy || pending || !settings
          }
          onClick={() => {
            void check();
          }}
        >
          {checking ? "Checking supported options…" : "Check supported options"}
        </Button>
        {serialized ? (
          <>
            <pre role="region" aria-label="Equivalent session command">
              {serialized.equivalentCommand}
            </pre>
            <p>{serialized.stdinNote}</p>
            <p>
              Initialize a private native thread, then send this prompt on
              stdin. Later turns resume only the exact saved thread. Approval
              choices are offered only by a live native request.
            </p>
            <dl>
              <dt>Requested model</dt>
              <dd>{serialized.thread.model}</dd>
              <dt>Sandbox</dt>
              <dd>{serialized.thread.sandbox}</dd>
              <dt>Approvals</dt>
              <dd>{serialized.thread.approvalPolicy}</dd>
            </dl>
            <p>
              Checked CLI {snapshot?.capabilities.version}. The server rechecks
              options and scope on Start.
            </p>
          </>
        ) : (
          <p role="status">{validation}</p>
        )}
        {problem && (
          <p role="status" class="af-session-warning">
            {problem}
          </p>
        )}
        {view.notice && <p role="status">{view.notice}</p>}
        {pending && (
          <div class="af-session-composer-row">
            <Button
              disabled={view.loading}
              onClick={() => {
                void client.refresh(project.id);
              }}
            >
              Check original Start
            </Button>
            {view.pendingStart && (
              <Button
                disabled={!writesAllowed || view.starting}
                onClick={() => {
                  void client.retryStart(project.id);
                }}
              >
                Retry original Start
              </Button>
            )}
          </div>
        )}
        <div class="af-session-composer-actions">
          <Button onClick={onCancel}>
            {pending ? "Close composer (Start still pending)" : "Cancel"}
          </Button>
          <Button variant="primary" disabled={!canStart} onClick={start}>
            Start
          </Button>
        </div>
        <small>
          Ctrl/Cmd+Enter starts · Cancel preserves the draft · preview starts no
          model
        </small>
      </footer>
    </section>
  );
}
