import { useEffect, useRef, useState } from "preact/hooks";
import { actionOutcome } from "../../../docs/js/action-outcome";
import { Button } from "../../../docs/js/ds/Button";
import { operatorPost } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import { serializeClaudeLaunch } from "../../../scripts/sessions/claude-launch";
import { sessionPreviewReceiptSchema } from "../../../scripts/sessions/protocol";
import type { WorktreeEntry } from "../../../types/beads";
import type { ConversationObject } from "../../../types/conversation";
import type { SmithsView } from "../../../types/hearth";
import type { ProjectRecord } from "../../../types/projects";
import type { ProviderReadinessPage } from "../../../types/provider-readiness";
import type { SerializedClaudeLaunch } from "../../../types/session-launch";
import type { SessionTurnSnapshot } from "../../../types/session-turn";
import { KeeperSuggestions } from "./KeeperSuggestions";
import type { KeeperClient } from "./keeper-client";
import { insertKeeperSuggestion, keeperPicker } from "./keeper-context";
import { providerUsageLabel, readinessLabel } from "./providers-model";
import type { SessionsClient } from "./session-client";
import {
  chooseSessionSmith,
  sessionAttachments,
  sessionStartBody,
  validateSessionAttachments,
} from "./session-composer";
import "./session.css";

const templates = [
  [
    "New skill",
    "Create a focused skill for this project. First inspect the existing skill conventions, then propose the behavior and verification.",
  ],
  [
    "Fix a bug",
    "Investigate this bug, reproduce it with a focused test, then implement and verify a fix:\n",
  ],
  [
    "Review a PR",
    "Review this pull request for actionable correctness and regression risks:\n",
  ],
  [
    "Research a question",
    "Research this question using the project's actual code and documented decisions:\n",
  ],
  [
    "Plan a feature",
    "Inspect the code and prepare a small, testable implementation plan for this feature:\n",
  ],
] as const;

export function SessionComposer({
  project,
  client,
  keeper,
  writesAllowed,
  onCancel,
  onStarted,
  providers,
}: {
  project: ProjectRecord;
  client: SessionsClient;
  keeper: KeeperClient;
  writesAllowed: boolean;
  onCancel(): void;
  onStarted(id: string): void;
  providers?: ProviderReadinessPage | null;
}) {
  const view = client.project(project.id),
    draft = view.composer,
    worktreeAction = client.worktrees.get(project.id);
  const [settings, setSettings] = useState<{
    smiths: SmithsView;
    worktrees: WorktreeEntry[];
  } | null>(null);
  const [problem, setProblem] = useState("");
  const [checking, setChecking] = useState(false);
  const [snapshot, setSnapshot] = useState<SessionTurnSnapshot | null>(null);
  const [attaching, setAttaching] = useState(false);
  const prompt = useRef<HTMLTextAreaElement>(null),
    pickerRegion = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0),
    [pickerVisible, setPickerVisible] = useState(false);
  const startAtOpen = useRef(view.lastStarted);
  const claudeReadiness = providers?.providers.find(
    (provider) => provider.provider === "claude",
  );
  const edit = (change: Partial<typeof draft>) =>
    client.editComposer(project.id, change);
  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const [smiths, worktrees] = await Promise.all([
          readOperatorRoute<SmithsView>("/smiths", pageReads()),
          readOperatorRoute<WorktreeEntry[]>("/worktrees", pageReads()),
        ]);
        if (!current) return;
        if (!Array.isArray(smiths.smiths) || !Array.isArray(worktrees))
          throw new Error("The launch choices could not be read.");
        setSettings({ smiths, worktrees });
        if (!client.project(project.id).composer.initialized) {
          const original = client.project(project.id).composer,
            selected = smiths.smiths.find(
              (item) => item.name === smiths.defaultSmith,
            );
          const repository =
            [
              ...new Set(
                project.workspaces.flatMap((scope) => scope.repositories),
              ),
            ][0] ?? "";
          const main = worktrees.find(
            (item) => item.kind === "main" && !item.missing,
          );
          const options =
            selected?.enabled && selected.provider === "claude"
              ? chooseSessionSmith(original, selected)
              : {
                  ...original,
                  smith: smiths.defaultSmith,
                  model: selected?.model ?? "",
                  effort: selected?.effort ?? "",
                };
          client.editComposer(project.id, {
            ...options,
            initialized: true,
            repository,
            worktree: main?.path ?? "",
          });
        }
      } catch {
        if (current)
          setProblem(
            "Session choices could not be loaded. Reopen the composer to read the repository and smith configuration again.",
          );
      }
    })();
    return () => {
      current = false;
    };
  }, [project.id, client]);
  useEffect(() => {
    if (view.lastStarted && view.lastStarted !== startAtOpen.current)
      onStarted(view.lastStarted);
  }, [view.lastStarted, onStarted]);
  const created =
    worktreeAction.receipt?.state === "created"
      ? worktreeAction.receipt.worktree
      : null;
  useEffect(() => {
    const original = worktreeAction.original;
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
      client.editComposer(project.id, {
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
    worktreeAction.original,
    draft.where,
    draft.repository,
    draft.baseRef,
    draft.branch,
    draft.beadId,
    draft.createdWorktree?.path,
    client,
    project.id,
  ]);
  const selectedSmith = settings?.smiths.smiths.find(
    (item) => item.name === draft.smith,
  );
  const main = settings?.worktrees.find(
    (item) => item.kind === "main" && !item.missing,
  );
  const repositories = [
    ...new Set(project.workspaces.flatMap((scope) => scope.repositories)),
  ];
  let serialized: SerializedClaudeLaunch | null = null,
    validation = "";
  try {
    const body = sessionStartBody(draft);
    if (snapshot)
      serialized = serializeClaudeLaunch(
        {
          ...body.launch,
          context: {
            projectId: project.id,
            repository: body.repository,
            worktree: body.worktree,
            ...(body.beadId ? { beadId: body.beadId } : {}),
            about: body.about,
          },
        },
        snapshot.capabilities,
      );
    else
      validation =
        "Check supported options before starting. This check starts no model.";
  } catch (error) {
    validation =
      error instanceof Error
        ? error.message
        : "Review the selected launch options.";
  }
  const busy = checking || attaching || view.starting;
  const canStart =
    claudeReadiness?.authentication.mode !== "signed-out" &&
    writesAllowed &&
    !project.archived &&
    !busy &&
    !view.pendingStart &&
    !!serialized &&
    selectedSmith?.enabled === true &&
    selectedSmith.provider === "claude";
  const start = () => {
    if (!canStart) return;
    try {
      void client.start(
        project.id,
        sessionStartBody(client.project(project.id).composer),
      );
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "Review the selected launch options.",
      );
    }
  };
  const check = async () => {
    if (busy || view.pendingStart || !writesAllowed) return;
    setChecking(true);
    setProblem("");
    try {
      const input = {
        ...sessionStartBody(client.project(project.id).composer),
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
      if (result.state !== "done") throw new Error(result.message);
      const checked = sessionPreviewReceiptSchema.safeParse(result.data);
      if (
        !checked.success ||
        checked.data.projectId !== project.id ||
        checked.data.requestId !== input.requestId ||
        checked.data.snapshot.smith !== input.smith ||
        checked.data.snapshot.cwd !== input.worktree
      )
        throw new Error(
          "The supported-options reply did not match the reviewed request.",
        );
      const expected = serializeClaudeLaunch(
        {
          ...input.launch,
          context: {
            projectId: project.id,
            repository: input.repository,
            worktree: input.worktree,
            ...(input.beadId ? { beadId: input.beadId } : {}),
            about: input.about ?? [],
          },
        },
        checked.data.snapshot.capabilities,
      );
      for (const key of Object.keys(expected) as Array<
        keyof SerializedClaudeLaunch
      >)
        if (
          JSON.stringify(expected[key]) !==
          JSON.stringify(checked.data.serialized[key])
        )
          throw new Error(
            "The supported-options reply changed the reviewed session input.",
          );
      setSnapshot(checked.data.snapshot);
    } catch (error) {
      setSnapshot(null);
      setProblem(
        error instanceof Error
          ? error.message
          : "Supported options could not be checked. No session was started.",
      );
    } finally {
      setChecking(false);
    }
  };
  const choose = (value: string, object?: ConversationObject) => {
    const picker = keeperPicker(draft.prompt, caret);
    if (!picker) return;
    const insertion = insertKeeperSuggestion(draft.prompt, picker, value),
      changingKind = value.endsWith(":");
    edit({
      prompt: changingKind
        ? insertion.text.slice(0, insertion.caret - 1) +
          insertion.text.slice(insertion.caret)
        : insertion.text,
      ...(object &&
      !draft.about.some(
        (item) => item.kind === object.kind && item.id === object.id,
      )
        ? { about: [...draft.about, object] }
        : {}),
    });
    const position = insertion.caret - (changingKind ? 1 : 0);
    setCaret(position);
    setPickerVisible(changingKind);
    requestAnimationFrame(() => {
      prompt.current?.focus();
      prompt.current?.setSelectionRange(position, position);
    });
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
        <button type="button" aria-pressed="true">
          Cl · Claude
          <small>
            {claudeReadiness
              ? readinessLabel(claudeReadiness.state)
              : "Readiness not reported"}{" "}
            · {providerUsageLabel(claudeReadiness)}
          </small>
        </button>
        {["Codex", "Gemini", "Grok", "OpenRouter"].map((name) => (
          <button
            type="button"
            key={name}
            disabled
            title={`${name} session adapter is unavailable in this composer.`}
          >
            {name}
            <small>Session adapter unavailable</small>
          </button>
        ))}
      </div>
      {claudeReadiness?.authentication.mode === "signed-out" && (
        <p role="status">
          Claude reports signed out. Sign in with its own CLI, then recheck
          provider readiness before starting.
        </p>
      )}
      <label>
        Prompt
        <textarea
          ref={prompt}
          autofocus
          aria-label="Session prompt"
          rows={5}
          maxLength={16_384}
          value={draft.prompt}
          onInput={(event) => {
            edit({ prompt: event.currentTarget.value });
            setCaret(event.currentTarget.selectionStart);
            setPickerVisible(true);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={(event) => {
            if (
              event.key === "Escape" &&
              pickerVisible &&
              keeperPicker(draft.prompt, caret)
            ) {
              event.preventDefault();
              event.stopPropagation();
              setPickerVisible(false);
            }
            if (
              event.key === "ArrowDown" &&
              pickerVisible &&
              keeperPicker(draft.prompt, caret)
            ) {
              const first =
                pickerRegion.current?.querySelector<HTMLButtonElement>(
                  "button:not([disabled])",
                );
              if (first) {
                event.preventDefault();
                first.focus();
              }
            }
          }}
        />
      </label>
      <KeeperSuggestions
        projectId={project.id}
        client={keeper}
        text={draft.prompt}
        caret={caret}
        visible={pickerVisible}
        region={pickerRegion}
        aboutCount={draft.about.length}
        recipient="this session"
        onChoose={choose}
        onClose={() => {
          setPickerVisible(false);
          prompt.current?.focus();
        }}
      />
      <div class="af-session-composer-row">
        <label>
          Templates
          <select
            aria-label="Session template"
            value=""
            onChange={(event) => {
              const template = templates.find(
                ([name]) => name === event.currentTarget.value,
              );
              if (template) edit({ prompt: template[1] });
            }}
          >
            <option value="">Insert a prompt template…</option>
            {templates.map(([name]) => (
              <option value={name} key={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Attach text or images
          <input
            type="file"
            aria-label="Session attachments"
            multiple
            accept=".txt,.md,.json,.csv,.yaml,.yml,.ts,.js,.tsx,.jsx,.py,.rs,image/png,image/jpeg,image/gif,image/webp"
            disabled={attaching || !!view.pendingStart}
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              setAttaching(true);
              void sessionAttachments(files)
                .then((items) => {
                  const combined = [
                    ...client.project(project.id).composer.attachments,
                    ...items,
                  ];
                  validateSessionAttachments(combined);
                  edit({ attachments: combined });
                })
                .catch((error) =>
                  setProblem(
                    error instanceof Error
                      ? error.message
                      : "The attachments could not be read.",
                  ),
                )
                .finally(() => setAttaching(false));
            }}
          />
        </label>
      </div>
      <p class="af-session-note">
        @ mentions and / commands insert draft text only. Attachments are sent
        inline when you explicitly Start. Sign-in and provider allowance are not
        reported by this CLI check.
      </p>
      <div class="af-session-chips">
        {draft.attachments.map((item, index) => (
          <span key={`${item.name}:${index}`}>
            {item.kind} · {item.name}
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
              disabled={!settings}
              value={draft.repository}
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
              disabled={!settings}
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
          <p class="af-session-warning">Edits land in your working copy.</p>
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
                .filter((item) => !item.missing)
                .map((item) => (
                  <option key={item.path} value={item.path}>
                    {item.branch ?? "Detached"} · {item.path}
                  </option>
                ))}
            </select>
          </label>
        ) : (
          <div class="af-session-new-worktree">
            <p>
              Creating a worktree is a separate explicit action. It creates a
              branch and directory; it starts no provider.
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
                  placeholder="feat/my-session"
                  value={draft.branch}
                  onInput={(event) =>
                    edit({ branch: event.currentTarget.value })
                  }
                />
              </label>
            </div>
            {worktreeAction.receipt?.worktree && (
              <p>
                Requested worktree: {worktreeAction.receipt.worktree.path} ·{" "}
                {worktreeAction.receipt.state === "created"
                  ? "Created"
                  : "Outcome unconfirmed; this path cannot start a session"}
              </p>
            )}
            {worktreeAction.notice && (
              <p role="status">{worktreeAction.notice}</p>
            )}
            <div class="af-session-composer-row">
              {!worktreeAction.original ? (
                <Button
                  disabled={
                    !writesAllowed ||
                    worktreeAction.posting ||
                    !!view.pendingStart
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
              ) : worktreeAction.receipt &&
                worktreeAction.receipt.state !== "unknown" ? (
                <Button
                  disabled={worktreeAction.posting || worktreeAction.checking}
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
                    disabled={worktreeAction.checking}
                    onClick={() => {
                      void client.worktrees.check(project.id);
                    }}
                  >
                    Check original worktree
                  </Button>
                  <Button
                    disabled={
                      !writesAllowed ||
                      worktreeAction.posting ||
                      !!view.pendingStart
                    }
                    onClick={() => {
                      void client.worktrees.retry(project.id);
                    }}
                  >
                    Retry original worktree
                  </Button>
                </>
              )}
            </div>
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
              value={draft.mode}
              onChange={(event) =>
                edit({
                  mode: event.currentTarget.value === "task" ? "task" : "chat",
                })
              }
            >
              <option value="chat">Chat · accepts subsequent turns</option>
              <option value="task">Task · one run, then ends</option>
            </select>
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Smith preset</legend>
        <label>
          Source smith
          <select
            aria-label="Session smith"
            disabled={!settings}
            value={draft.smith}
            onChange={(event) => {
              const chosen = settings?.smiths.smiths.find(
                (item) => item.name === event.currentTarget.value,
              );
              if (chosen) {
                try {
                  edit(chooseSessionSmith(draft, chosen));
                } catch (error) {
                  setProblem(
                    error instanceof Error
                      ? error.message
                      : "This smith is unavailable.",
                  );
                }
              }
            }}
          >
            <option value="">Choose a smith…</option>
            {settings?.smiths.smiths.map((item) => (
              <option
                key={item.name}
                value={item.name}
                disabled={!item.enabled || item.provider !== "claude"}
              >
                {item.name} · {item.model}
                {!item.enabled
                  ? " · disabled"
                  : item.provider !== "claude"
                    ? " · adapter unavailable"
                    : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.custom}
            onChange={(event) => edit({ custom: event.currentTarget.checked })}
          />
          Custom options · retain the source smith as provenance
        </label>
        <Button
          disabled
          title="Saving smith configuration is unavailable in this build."
        >
          Save as smith unavailable
        </Button>
      </fieldset>
      <fieldset>
        <legend>Provider options</legend>
        <div class="af-session-composer-row">
          <label>
            Model
            <input
              aria-label="Session model"
              value={draft.model}
              readOnly={!draft.custom}
              onInput={(event) => edit({ model: event.currentTarget.value })}
            />
          </label>
          <label>
            Reasoning effort
            <select
              aria-label="Session effort"
              disabled={!settings}
              value={draft.effort}
              onChange={(event) =>
                edit({ effort: event.currentTarget.value, custom: true })
              }
            >
              <option value="">
                CLI default · explicitly leave effort unset
              </option>
              {["low", "medium", "high", "xhigh", "max"].map((effort) => (
                <option value={effort} key={effort}>
                  {effort}
                </option>
              ))}
              {draft.effort &&
                !["low", "medium", "high", "xhigh", "max"].includes(
                  draft.effort,
                ) && (
                  <option value={draft.effort}>
                    {draft.effort} · configured, unsupported
                  </option>
                )}
              <option disabled>
                ultracode · unavailable in the observed CLI
              </option>
            </select>
          </label>
        </div>
        <p class="af-session-note">
          Configured effort is kept until you explicitly change it. A CLI flag
          alone does not verify effort support for an exact model.
        </p>
        <label>
          Permissions and sandbox
          <select
            aria-label="Session permission mode"
            value={draft.permissionMode}
            onChange={(event) =>
              edit({
                permissionMode:
                  event.currentTarget.value === "plan" ? "plan" : "acceptEdits",
              })
            }
          >
            <option value="acceptEdits">
              Accept edits · harness-approved tool policy
            </option>
            <option value="plan">Plan · review before changes</option>
            {["Default", "Auto", "Don't ask"].map((name) => (
              <option key={name} disabled>
                {name} · approval integration unavailable
              </option>
            ))}
            <option disabled>
              Bypass permissions · locked by harness policy
            </option>
          </select>
        </label>
        <details>
          <summary>Tools and advanced options</summary>
          <p>
            The coding tool policy is fixed by the harness. Permission bypass,
            arbitrary tools, agents, plugins, MCP servers, hooks, settings and
            raw flags are locked until their reviewed integration exists.
          </p>
          <label>
            Fallback models (up to three)
            <input
              aria-label="Fallback session models"
              value={draft.fallbackModels}
              onInput={(event) =>
                edit({ fallbackModels: event.currentTarget.value })
              }
              placeholder="Comma-separated model ids; checked before Start"
            />
          </label>
          <label>
            Extra directories (one per line)
            <textarea
              aria-label="Session extra directories"
              rows={2}
              value={draft.extraDirectories}
              onInput={(event) =>
                edit({ extraDirectories: event.currentTarget.value })
              }
              placeholder="Absolute directories inside the selected worktree"
            />
          </label>
          <label>
            Raw flags · locked
            <input
              disabled
              aria-label="Raw session flags locked"
              placeholder="Unsupported flags cannot be passed to the CLI."
            />
          </label>
          <p>
            Thinking switches and maximum-turn limits are unavailable in the
            observed CLI capability set.
          </p>
        </details>
        {draft.mode === "task" && (
          <div class="af-session-composer-row">
            <label>
              Maximum spend in USD (list-price estimate)
              <input
                type="number"
                min="0.01"
                step="0.01"
                aria-label="Task maximum budget"
                value={draft.maxBudgetUsd}
                onInput={(event) =>
                  edit({ maxBudgetUsd: event.currentTarget.value })
                }
                placeholder="CLI default when empty"
              />
            </label>
            <label>
              Output schema (JSON object)
              <textarea
                aria-label="Task output schema"
                rows={3}
                value={draft.outputSchema}
                onInput={(event) =>
                  edit({ outputSchema: event.currentTarget.value })
                }
                placeholder="CLI default when empty"
              />
            </label>
          </div>
        )}
      </fieldset>
      <footer class="af-session-preview">
        <h3>Equivalent command</h3>
        <Button
          disabled={!writesAllowed || busy || !!view.pendingStart || !settings}
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
        {view.pendingStart && (
          <div class="af-session-composer-row">
            <Button
              onClick={() => {
                void client.refresh(project.id);
              }}
              disabled={view.loading}
            >
              Check original Start
            </Button>
            <Button
              onClick={() => {
                void client.retryStart(project.id);
              }}
              disabled={!writesAllowed || view.starting}
            >
              Retry original Start
            </Button>
          </div>
        )}
        <div class="af-session-composer-actions">
          <Button onClick={onCancel}>
            {view.pendingStart
              ? "Close composer (Start still pending)"
              : "Cancel"}
          </Button>
          <Button variant="primary" disabled={!canStart} onClick={start}>
            Start
          </Button>
        </div>
        <small>
          Ctrl/Cmd+Enter starts · Cancel preserves the draft · nothing starts
          from templates or preview
        </small>
      </footer>
    </section>
  );
}
