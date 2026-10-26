import { useEffect, useRef, useState } from "preact/hooks";
import { actionOutcome } from "../../../docs/js/action-outcome";
import { Button } from "../../../docs/js/ds/Button";
import { operatorPost } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import { geminiChatLaunchFromStart } from "../../../scripts/sessions/gemini-chat-owned-preparation";
import { geminiChatPreviewReceiptSchema } from "../../../scripts/sessions/gemini-chat-preview-protocol";
import { serializeGeminiChat } from "../../../scripts/sessions/gemini-task";
import type { WorktreeEntry } from "../../../types/beads";
import type { OwnedSessionStartInput } from "../../../types/codex-owned-task";
import type { GeminiChatPreviewReceipt } from "../../../types/gemini-owned-chat";
import type { SmithsView } from "../../../types/hearth";
import {
  chooseGeminiChatSmith,
  geminiChatStartBody,
  matchesGeminiChatPreview,
  reviewedGeminiChatStart,
} from "./gemini-chat-composer";
import { providerUsageLabel, readinessLabel } from "./providers-model";
import type { SessionComposerProps } from "./SessionComposer";
import { SessionStartIdentityControls } from "./SessionStartIdentityControls";
import { chooseSessionSmith, sessionAttachments } from "./session-composer";

/** Explicit scoped native Gemini CLI Chats; untouched native defaults remain omitted. */
export function GeminiChatComposer({
  project,
  client,
  writesAllowed,
  onCancel,
  onStarted,
  onOpenOriginal,
  providers,
}: SessionComposerProps) {
  const geminiReadiness = providers?.providers.find(
      (provider) => provider.provider === "gemini",
    ),
    claudeReadiness = providers?.providers.find(
      (provider) => provider.provider === "claude",
    );
  const view = client.project(project.id),
    draft = view.composer,
    options = view.geminiChatComposer;
  const action = client.worktrees.get(project.id);
  const [settings, setSettings] = useState<{
    smiths: SmithsView;
    worktrees: WorktreeEntry[];
  } | null>(null);
  const [preview, setPreview] = useState<GeminiChatPreviewReceipt | null>(null),
    [problem, setProblem] = useState("");
  const [checking, setChecking] = useState(false),
    [attaching, setAttaching] = useState(false);
  const prompt = useRef<HTMLTextAreaElement>(null),
    startAtOpen = useRef(view.lastStarted);
  const edit = (value: Partial<typeof draft>) =>
    client.editComposer(project.id, value);
  const editOptions = (value: Partial<typeof options>) =>
    client.editGeminiChatComposer(project.id, value);
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
        if (!current.geminiChatComposer.initialized) {
          const selected =
            smiths.smiths.find(
              (smith) =>
                smith.name === smiths.defaultSmith &&
                smith.enabled &&
                smith.provider === "gemini",
            ) ??
            smiths.smiths.find(
              (smith) => smith.enabled && smith.provider === "gemini",
            );
          editOptions(
            selected
              ? { initialized: true, smith: selected.name }
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
  const supports = (flag: string) =>
    !snapshot || snapshot.capabilities.flags.includes(flag);
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
  const identityReady =
    !!view.identityPage &&
    !view.identityLoading &&
    view.identityGeneration !== null;
  let recoveryInput: OwnedSessionStartInput | null = null;
  let validation =
    "Check supported options before starting. This check starts no model.";
  try {
    recoveryInput = geminiChatStartBody(draft, options);
  } catch (error) {
    validation =
      error instanceof Error ? error.message : "Review the Chat options.";
  }
  const serialized = matchesGeminiChatPreview(
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
    identityReady &&
    !!serialized &&
    source?.enabled === true &&
    source.provider === "gemini";
  const start = () => {
    if (!canStart) return;
    try {
      const fresh = client.project(project.id);
      void client.start(
        project.id,
        reviewedGeminiChatStart(project.id, fresh, preview),
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
        ...geminiChatStartBody(
          client.project(project.id).composer,
          client.project(project.id).geminiChatComposer,
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
      const checked = geminiChatPreviewReceiptSchema.safeParse(result.data);
      if (
        !checked.success ||
        checked.data.projectId !== project.id ||
        checked.data.requestId !== input.requestId ||
        checked.data.snapshot.smith !== input.smith ||
        checked.data.snapshot.launch.cwd !== input.worktree
      )
        throw Error("The preview did not match this original Chat request.");
      const expected = serializeGeminiChat(
        geminiChatLaunchFromStart(project.id, input),
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
        <button
          type="button"
          aria-pressed="false"
          onClick={() => client.chooseComposerProvider(project.id, "codex")}
        >
          Cx · Codex<small>Task and native Chat</small>
        </button>
        <button type="button" aria-pressed="true">
          Gm · Gemini
          <small>
            Task and Chat ·{" "}
            {geminiReadiness
              ? readinessLabel(geminiReadiness.state)
              : "Readiness not reported"}{" "}
            · {providerUsageLabel(geminiReadiness)}
          </small>
        </button>
        {["Grok", "OpenRouter"].map((name) => (
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
      {!settings && !problem && (
        <p role="status">Loading scoped Gemini launch choices…</p>
      )}
      {geminiReadiness?.authentication.mode === "signed-out" && (
        <p role="status">
          Gemini reports signed out. Sign in with its own CLI, then refresh
          provider readiness.
        </p>
      )}
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
                      "Images require server-owned staging and are unavailable for Gemini Chats.",
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
                client.chooseGeminiMode(
                  project.id,
                  event.currentTarget.value === "chat" ? "chat" : "task",
                )
              }
            >
              <option value="task">Task · one run, then ends</option>
              <option value="chat">
                Chat · native session and once permissions
              </option>
            </select>
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Gemini CLI options</legend>
        <label>
          Source smith
          <select
            aria-label="Session smith"
            value={options.smith}
            disabled={!settings || !options.initialized}
            onChange={(event) => {
              const smith = settings?.smiths.smiths.find(
                (item) => item.name === event.currentTarget.value,
              );
              if (smith) editOptions(chooseGeminiChatSmith(options, smith));
            }}
          >
            <option value="">Choose an enabled Gemini smith</option>
            {settings?.smiths.smiths.map((smith) => (
              <option
                key={smith.name}
                value={smith.name}
                disabled={!smith.enabled || smith.provider !== "gemini"}
              >
                {smith.name} · {smith.model}
                {!smith.enabled
                  ? " · disabled"
                  : smith.provider !== "gemini"
                    ? " · different provider"
                    : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Requested model
          <input
            aria-label="Session model"
            maxLength={200}
            placeholder="CLI default model"
            value={options.model}
            disabled={!settings || !options.initialized || !supports("--model")}
            onInput={(event) =>
              editOptions({ model: event.currentTarget.value })
            }
          />
        </label>
        {!supports("--model") && (
          <p role="status">
            This CLI did not advertise a model override.{" "}
            <Button onClick={() => editOptions({ model: "" })}>
              Use CLI default model
            </Button>
          </p>
        )}
        <p class="af-session-note">
          Leave the model blank to use the native CLI default. Choosing a smith
          preset explicitly copies its configured model. Gemini CLI has no
          native effort option.
        </p>
        <div class="af-session-composer-row">
          <label>
            Approvals
            <select
              aria-label="Session approvals"
              value={options.approvalMode}
              disabled={!settings || !options.initialized}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (
                  value === "" ||
                  value === "default" ||
                  value === "auto_edit" ||
                  value === "plan"
                )
                  editOptions({ approvalMode: value });
              }}
            >
              <option value="">CLI default · leave approvals unset</option>
              <option value="default" disabled={!supports("--approval-mode")}>
                Default · explicitly select native default
              </option>
              <option value="plan" disabled={!supports("--approval-mode")}>
                Plan · inspect before changes
              </option>
              <option value="auto_edit" disabled={!supports("--approval-mode")}>
                Auto edit · native edits policy
              </option>
              <option value="yolo" disabled>
                Bypass approvals · locked by harness policy
              </option>
            </select>
          </label>
          <label>
            Sandbox
            <select
              aria-label="Session sandbox"
              value={options.sandbox}
              disabled={!settings || !options.initialized}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === "" || value === "enabled")
                  editOptions({ sandbox: value });
              }}
            >
              <option value="">CLI default · leave sandbox unset</option>
              <option value="enabled" disabled={!supports("--sandbox")}>
                Enabled
              </option>
              <option value="disabled" disabled>
                Disabled · locked by harness policy
              </option>
            </select>
          </label>
        </div>
        {(!supports("--approval-mode") || !supports("--sandbox")) && (
          <p role="status">
            This native help report does not support every optional control.
            Leave unavailable options at CLI default.
          </p>
        )}
        <label>
          Provider route
          <select aria-label="Session provider route" value="gemini-cli">
            <option value="gemini-cli">Gemini CLI · native ACP Chat</option>
            <option disabled>
              Antigravity / alternate routes · unavailable
            </option>
          </select>
        </label>
        <p class="af-session-note">
          Custom policy paths, extra directories and raw flags require scoped
          controls and are unavailable here. This Chat offers only actual native
          one-time permission choices. Sign-in and remaining allowance are
          separate provider reports.
        </p>
      </fieldset>
      <footer class="af-session-preview">
        <h3>Equivalent command</h3>
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
            <dl>
              <dt>Requested model</dt>
              <dd>{snapshot?.launch.model ?? "CLI default model"}</dd>
              <dt>Approvals</dt>
              <dd>{snapshot?.launch.approvalMode ?? "CLI default"}</dd>
              <dt>Sandbox</dt>
              <dd>{snapshot?.launch.sandbox ? "Enabled" : "CLI default"}</dd>
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
        <SessionStartIdentityControls
          projectId={project.id}
          view={view}
          client={client}
          request={recoveryInput}
          writesAllowed={writesAllowed}
          archived={project.archived}
          onOpenOriginal={onOpenOriginal}
        />
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
