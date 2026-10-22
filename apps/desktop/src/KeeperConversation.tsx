import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { Icon } from "../../../docs/js/ds/Icon";
import type {
  ConversationEvent,
  ConversationPage,
} from "../../../types/conversation";
import type { ProjectRecord } from "../../../types/projects";
import { KeeperMarkdown } from "./KeeperMarkdown";
import type { KeeperClient } from "./keeper-client";
import { keeperContext, keeperTurns } from "./keeper-model";
import { desktopHref } from "./navigation";
import "./keeper.css";

const suggestions = [
  "What changed since yesterday?",
  "What's blocked and why?",
  "What should I approve next?",
];
type ReadTrace = Extract<ConversationEvent, { kind: "read" }>;
function readHref(projectId: string, read: ReadTrace, id: string): string {
  const selection = {
    kind:
      read.query === "sessions"
        ? ("session" as const)
        : read.query === "runs"
          ? ("run" as const)
          : read.query === "activity"
            ? ("event" as const)
            : ("bead" as const),
    id,
  };
  const destination =
    read.query === "sessions"
      ? "sessions"
      : read.query === "runs"
        ? "runs"
        : read.query === "activity"
          ? "activity"
          : read.query === "queue"
            ? "workbench"
            : "beads";
  return desktopHref({ projectId, destination, selection });
}
function ReadTraces({
  projectId,
  reads,
  onNavigate,
}: {
  projectId: string;
  reads: ReadTrace[];
  onNavigate?: (() => void) | undefined;
}): JSX.Element {
  const incomplete = reads.some((read) => !read.complete);
  return (
    <details class="af-keeper-reads">
      <summary>
        What the Keeper looked at · {reads.length}{" "}
        {reads.length === 1 ? "read" : "reads"}
        {incomplete ? " · incomplete" : ""}
      </summary>
      {reads.map((read, index) => (
        <div key={`${read.asOf}-${index}`}>
          <p>
            {read.source} ·{" "}
            <time dateTime={read.asOf}>
              {new Date(read.asOf).toLocaleString()}
            </time>
          </p>
          {!read.complete && (
            <p class="af-keeper-warning">
              {read.reason ??
                "This read is incomplete. The answer may be incomplete."}
            </p>
          )}
          {read.ids.length > 0 ? (
            <div class="af-keeper-object-links">
              {read.ids.map((id) => (
                <a
                  key={id}
                  href={readHref(projectId, read, id)}
                  onClick={onNavigate}
                >
                  {id}
                </a>
              ))}
            </div>
          ) : (
            <p>No record ids were returned.</p>
          )}
          {read.nextCursor !== null && (
            <p>More source records are available after this page.</p>
          )}
        </div>
      ))}
    </details>
  );
}

export function KeeperScope({
  project,
  page,
}: {
  project: ProjectRecord;
  page: ConversationPage | null;
}): JSX.Element {
  const context = keeperContext(page);
  return (
    <div class="af-keeper-scope">
      <h2>What the Keeper sees</h2>
      <p>Saved scope for {project.name}</p>
      <p>
        <code>project:{project.slug}</code> together with the saved epics. Both
        must match.
      </p>
      {project.workspaces.map((scope) => (
        <section key={scope.root}>
          <h3>Workspace</h3>
          <code>{scope.root}</code>
          <h3>Repositories</h3>
          <ul>
            {scope.repositories.map((repo) => (
              <li key={repo}>
                <code>{repo}</code>
              </li>
            ))}
          </ul>
          <h3>Epics</h3>
          <ul>
            {scope.epicIds.map((id) => (
              <li key={id}>
                <code>{id}</code>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <h2>Context</h2>
      <p>{context.label}</p>
      <p>{context.detail}</p>
      <p>
        Read traces identify which sources were actually read and when. A saved
        scope alone does not mean every record was read.
      </p>
    </div>
  );
}

export function KeeperConversation({
  project,
  client,
  writesAllowed,
  compact = false,
  onNavigate,
  onScope,
}: {
  project: ProjectRecord;
  client: KeeperClient;
  writesAllowed: boolean;
  compact?: boolean;
  onNavigate?: (() => void) | undefined;
  onScope?: () => void;
}): JSX.Element {
  const state = client.get(project.id);
  const rows = keeperTurns(state.page);
  const context = keeperContext(state.page);
  const process = state.page?.frames
    .map((frame) => frame.event)
    .reverse()
    .find((event) => event.kind === "process");
  const observed = state.page?.frames
    .map((frame) => frame.event)
    .reverse()
    .find((event) => event.kind === "model");
  const current = state.page?.turns.at(-1);
  const answering =
    current && ["accepted", "running", "cancelling"].includes(current.phase);
  const feed = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const [away, setAway] = useState(false);
  const [copyNotice, setCopyNotice] = useState("");
  const lastSeq = state.page?.frames.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (follow.current && feed.current)
      feed.current.scrollTop = feed.current.scrollHeight;
    else if (lastSeq > 0) setAway(true);
  }, [lastSeq]);
  useEffect(() => {
    if (input.current) {
      input.current.style.height = "auto";
      input.current.style.height = `${Math.min(160, input.current.scrollHeight)}px`;
    }
  }, [state.draft]);
  const jump = () => {
    follow.current = true;
    setAway(false);
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
  };
  return (
    <section
      class={`af-keeper-conversation${compact ? " is-compact" : ""}`}
      aria-label={`Keeper conversation for ${project.name}`}
    >
      <header class="af-keeper-header">
        <div class="af-keeper-heading">
          <span class="af-keeper-avatar" aria-hidden="true">
            FK
          </span>
          <h2>
            Forge Keeper <span>· {project.name}</span>
          </h2>
        </div>
        <div class="af-keeper-chips">
          <span
            class="af-keeper-chip"
            title={
              process?.kind === "process"
                ? `Requested ${process.requestedModel} · ${process.requestedEffort} effort`
                : undefined
            }
          >
            {process?.kind === "process"
              ? process.smith
              : "Smith checked on Send"}
          </span>
          {observed?.kind === "model" && (
            <span class="af-keeper-chip">Observed {observed.model}</span>
          )}
          {onScope ? (
            <button type="button" class="af-keeper-chip" onClick={onScope}>
              What the Keeper sees
            </button>
          ) : (
            <span class="af-keeper-chip">Scope · {project.name}</span>
          )}
          <span class="af-keeper-context" title={context.detail}>
            {context.label}
            {context.percent !== null && (
              <meter
                min={0}
                max={100}
                value={context.percent}
                aria-label={context.label}
              />
            )}
          </span>
        </div>
        {context.nearlyFull && (
          <p class="af-keeper-warning" role="status">
            Conversation context is nearly full. Review this conversation before
            continuing.
          </p>
        )}
      </header>
      {state.notice && (
        <div class="af-keeper-notice" role="status">
          <p>{state.notice}</p>
          {state.pending && !state.posting && (
            <>
              <Button
                onClick={() => {
                  void client.check(project.id);
                }}
              >
                Check original request
              </Button>
              <Button
                onClick={() => {
                  void client.retryOriginal(project.id);
                }}
                disabled={!writesAllowed}
              >
                Retry original request
              </Button>
            </>
          )}
          {state.stopping && (
            <Button
              onClick={() => {
                void client.check(project.id);
              }}
            >
              Check stop
            </Button>
          )}
          {state.stopUnknown && (
            <Button
              disabled={!writesAllowed || state.stopPosting}
              onClick={() => {
                void client.stop(project.id, true);
              }}
            >
              Retry stop
            </Button>
          )}
          {!state.live && (
            <Button onClick={() => client.reload(project.id)}>
              Reload conversation
            </Button>
          )}
        </div>
      )}
      <div
        ref={feed}
        class="af-keeper-thread"
        role="region"
        aria-label="Conversation history"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the named history region must receive keyboard scrolling.
        tabIndex={0}
        onScroll={() => {
          const node = feed.current;
          if (node) {
            follow.current =
              node.scrollHeight - node.scrollTop - node.clientHeight < 80;
            if (follow.current) setAway(false);
          }
        }}
      >
        {!state.loaded && (!state.notice || state.live) && (
          <p role="status">
            {state.page
              ? "Loading earlier conversation pages…"
              : "Loading the saved conversation…"}
          </p>
        )}
        {state.loaded && rows.length === 0 && (
          <div class="af-keeper-welcome">
            <Icon name="sparkle" size={30} />
            <h3>Your Keeper for {project.name}</h3>
            <p>
              Ask about what changed, what's blocked, or what you could approve
              next.
            </p>
          </div>
        )}
        {rows.map((row, index) => (
          <div class="af-keeper-turn" key={row.id}>
            {(index === 0 ||
              new Date(rows[index - 1]?.at ?? "").toLocaleDateString() !==
                new Date(row.at).toLocaleDateString()) && (
              <p class="af-keeper-day">
                <time dateTime={row.at}>
                  {new Date(row.at).toLocaleDateString()}
                </time>
              </p>
            )}
            {row.question && (
              <article class="af-keeper-question" aria-label="Your message">
                <p>{row.question}</p>
              </article>
            )}
            {(row.reply || row.reads.length > 0) && (
              <article class="af-keeper-reply" aria-label="Keeper reply">
                <span class="af-keeper-avatar" aria-hidden="true">
                  FK
                </span>
                <div>
                  <KeeperMarkdown text={row.reply} />
                  {row.reads.length > 0 && (
                    <ReadTraces
                      projectId={project.id}
                      reads={row.reads}
                      onNavigate={onNavigate}
                    />
                  )}
                  {row.reply && (
                    <button
                      type="button"
                      class="af-keeper-copy"
                      onClick={() => {
                        void (async () => {
                          try {
                            await navigator.clipboard.writeText(row.reply);
                            setCopyNotice("Reply copied.");
                          } catch {
                            setCopyNotice("The reply could not be copied.");
                          }
                        })();
                      }}
                    >
                      Copy reply
                    </button>
                  )}
                </div>
              </article>
            )}
            {row.turn &&
              ["unknown", "failed", "cancelled"].includes(row.turn.phase) && (
                <p class="af-keeper-warning">
                  {row.turn.phase === "unknown"
                    ? "Delivery unknown. "
                    : row.turn.phase === "cancelled"
                      ? "Stopped. "
                      : "The Keeper could not finish. "}
                  {row.turn.phase === "cancelled" ? "" : row.turn.reason}
                </p>
              )}
          </div>
        ))}
      </div>
      {away && (
        <Button class="af-keeper-jump" onClick={jump}>
          Jump to latest
        </Button>
      )}
      <div class="af-keeper-composer">
        <p class="af-keeper-status" role="status">
          {state.posting
            ? "Sending the original request…"
            : current?.phase === "cancelling" || state.stopping
              ? "Stopping… waiting for confirmation."
              : answering
                ? "Keeper is answering…"
                : current?.phase === "unknown"
                  ? "This turn has an unknown outcome and was not resent."
                  : state.live && state.loaded
                    ? "Ready"
                    : "Conversation updates unavailable"}
          {copyNotice ? ` · ${copyNotice}` : ""}
        </p>
        {!state.draft && rows.length === 0 && (
          <div class="af-keeper-suggestions">
            {suggestions.map((text) => (
              <button
                key={text}
                type="button"
                onClick={() => {
                  client.draft(project.id, text);
                  input.current?.focus();
                }}
              >
                {text}
              </button>
            ))}
          </div>
        )}
        <label
          class="af-keeper-label"
          for={`keeper-message-${compact ? "drawer" : "full"}`}
        >
          Message the Keeper
        </label>
        <textarea
          ref={input}
          id={`keeper-message-${compact ? "drawer" : "full"}`}
          rows={2}
          maxLength={16_384}
          value={state.draft}
          placeholder={`Ask about ${project.name}…`}
          aria-describedby={`keeper-hint-${compact ? "drawer" : "full"}`}
          onInput={(event) =>
            client.draft(project.id, event.currentTarget.value)
          }
          onKeyDown={(event) => {
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key === "Enter" &&
              !event.isComposing
            ) {
              event.preventDefault();
              void client.send(project.id);
            }
          }}
        />
        <div class="af-keeper-composer-actions">
          <small id={`keeper-hint-${compact ? "drawer" : "full"}`}>
            Ctrl/Cmd+Enter sends · Enter adds a line
          </small>
          {answering ? (
            <Button
              onClick={() => {
                void client.stop(project.id);
              }}
              disabled={
                !writesAllowed ||
                !state.page?.controllable ||
                Boolean(state.stopping) ||
                current.phase === "cancelling"
              }
              title={
                state.page?.controllable
                  ? "Stop this supervised turn"
                  : "This hearth does not control the observed turn"
              }
            >
              Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!client.canSend(project.id)}
              onClick={() => {
                void client.send(project.id);
              }}
            >
              Send
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
