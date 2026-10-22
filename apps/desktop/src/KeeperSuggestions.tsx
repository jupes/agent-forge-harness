import type { JSX, RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { ConversationObject } from "../../../types/conversation";
import type { KeeperClient } from "./keeper-client";
import { keeperCommands, keeperPicker } from "./keeper-context";

type Choices = Awaited<ReturnType<KeeperClient["objects"]>>;

/** Suggestions only edit a human draft; they never execute a harness command. */
export function KeeperSuggestions({
  projectId,
  client,
  text,
  caret,
  visible,
  region,
  onChoose,
  onClose,
}: {
  projectId: string;
  client: KeeperClient;
  text: string;
  caret: number;
  visible: boolean;
  region: RefObject<HTMLDivElement>;
  onChoose(value: string, object?: ConversationObject): void;
  onClose(): void;
}): JSX.Element | null {
  const picker = visible ? keeperPicker(text, caret) : null;
  const kind = picker?.mode === "mention" ? picker.kind : null;
  const query = picker?.query ?? "";
  const owner = JSON.stringify([projectId, kind, query]);
  const [loaded, setLoaded] = useState<{
    owner: string;
    choices: Choices;
  } | null>(null);
  const [failedFor, setFailedFor] = useState<string | null>(null);
  // Rendering also checks ownership; an effect cleanup alone would leave the
  // previous query's choices visible for one paint before the effect runs.
  const choices = loaded?.owner === owner ? loaded.choices : null;
  const error = failedFor === owner;
  const loading = Boolean(kind && !choices && !error);
  useEffect(() => {
    let cancelled = false;
    if (!kind) return;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const index = await client.objects(projectId, kind);
          const search = query.toLowerCase();
          const items = index.items.filter((item) =>
            `${item.id} ${item.title}`.toLowerCase().includes(search),
          );
          // An exact id can be beyond the bounded index. The same sealed reader
          // decides whether it exists; a guessed id never grants membership.
          let result = { ...index, items };
          if (!items.length && query.trim()) {
            try {
              result = await client.objects(projectId, kind, query);
            } catch {
              /* Index provenance and honest no-match state remain. */
            }
          }
          if (!cancelled) {
            setLoaded({ owner, choices: result });
            setFailedFor(null);
          }
        } catch {
          if (!cancelled) setFailedFor(owner);
        }
      })();
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, projectId, kind, query, owner]);
  if (!picker) return null;
  const commands = picker.mode === "command" ? keeperCommands(query) : [];
  return (
    <div
      class="af-keeper-picker"
      ref={region}
      role="group"
      aria-label={
        picker.mode === "command" ? "Harness commands" : "Mention suggestions"
      }
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button:not([disabled])",
          ),
        );
        const index =
          document.activeElement instanceof HTMLButtonElement
            ? buttons.indexOf(document.activeElement)
            : -1;
        event.preventDefault();
        buttons[
          (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
            buttons.length
        ]?.focus();
      }}
    >
      {picker.mode === "command" ? (
        <>
          <p>
            Harness commands · inserts a request for the Keeper. Review before
            sending.
          </p>
          <div class="af-keeper-picker-options">
            {commands.map((command) => (
              <button
                key={command.name}
                type="button"
                onClick={() => onChoose(command.name)}
              >
                <strong>{command.name}</strong>
                <span>{command.description}</span>
                <small>{command.argumentHint}</small>
              </button>
            ))}
          </div>
          {!commands.length && (
            <p role="status">No matching harness commands.</p>
          )}
        </>
      ) : (
        <>
          <div
            class="af-keeper-picker-kinds"
            role="group"
            aria-label="Object kind"
          >
            {(["bead", "session", "run", "event"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={kind === value}
                onClick={() => onChoose(`@${value}:`)}
              >
                {value === "event"
                  ? "Activity"
                  : `${value[0]?.toUpperCase()}${value.slice(1)}s`}
              </button>
            ))}
          </div>
          {loading && (
            <p role="status">
              Reading scoped {kind === "event" ? "activity" : `${kind}s`}…
            </p>
          )}
          {error && (
            <p role="status">
              Mentions could not be read. Edit the query to try again, or close
              suggestions.
            </p>
          )}
          {choices && (
            <>
              <div class="af-keeper-picker-options">
                {choices.items.slice(0, 30).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    disabled={client.get(projectId).about.length >= 16}
                    onClick={() =>
                      onChoose(`@${item.kind}:${item.id}`, {
                        kind: item.kind,
                        id: item.id,
                      })
                    }
                  >
                    <strong>
                      {item.kind} {item.id}
                    </strong>
                    <span>{item.title}</span>
                  </button>
                ))}
              </div>
              {!choices.items.length && (
                <p role="status">
                  No matching objects in the available project read.
                </p>
              )}
              <p class="af-keeper-picker-source">
                {choices.source} · {new Date(choices.asOf).toLocaleString()}
                {!choices.complete
                  ? ` · ${choices.reason ?? "Incomplete source"}`
                  : ""}
                {choices.more || choices.items.length > 30
                  ? " · Showing a bounded list; type an exact id to look it up."
                  : ""}
              </p>
            </>
          )}
          <p class="af-keeper-picker-source">
            Use @bead:id, @session:id, @run:id or @event:id. File paths can be
            written as text; they are not attached or read by this picker.
          </p>
        </>
      )}
    </div>
  );
}
