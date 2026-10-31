import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Dialog } from "../../../docs/js/ds/Dialog";
import {
  movePaletteActive,
  type PaletteIndex,
  type PaletteIntent,
  type PaletteRow,
  paletteIntent,
  recentPaletteRows,
  searchPalette,
} from "./command-palette";
import "./command-palette.css";

export function CommandPalette({
  open,
  index,
  projectId,
  recents,
  onSelect,
  onRefresh,
  onClose,
}: {
  open: boolean;
  index: PaletteIndex | null;
  projectId: string | null;
  recents: readonly string[];
  onSelect: (intent: PaletteIntent, row: PaletteRow) => boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [selectionIssue, setSelectionIssue] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const rows = useMemo(() => {
    if (!index) return [];
    return query.trim()
      ? searchPalette(index, query, projectId)
      : recentPaletteRows(index, recents);
  }, [index, query, projectId, recents]);
  useEffect(() => {
    setQuery("");
    setActive(0);
    setSelectionIssue("");
  }, [open]);
  useEffect(() => {
    if (index) setSelectionIssue("");
  }, [index]);
  const choose = (row: PaletteRow | undefined) => {
    const intent = row && paletteIntent(row);
    if (row && intent && !row.unavailable && !onSelect(intent, row))
      setSelectionIssue(
        "This result changed or its owner is unavailable. Refresh results and try again.",
      );
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((value) => movePaletteActive(value, "ArrowDown", rows.length));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((value) => movePaletteActive(value, "ArrowUp", rows.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(rows[active]);
    }
  };
  return (
    <Dialog
      open={open}
      title="Command palette"
      titleId="af-command-palette-title"
      onClose={onClose}
      initialFocus="content"
      class="af-command-palette-dialog"
    >
      <div class="af-command-palette" onKeyDown={keyDown}>
        <label class="af-command-palette-search">
          <span class="af-sr-only">Search projects, work, and commands</span>
          <input
            ref={search}
            autoFocus
            value={query}
            onInput={(event) => {
              setQuery((event.currentTarget as HTMLInputElement).value);
              setActive(0);
            }}
            placeholder="Search projects, work, commands…"
            aria-controls="af-command-palette-results"
            aria-activedescendant={
              rows[active] ? `af-palette-${active}` : undefined
            }
            role="combobox"
            aria-expanded="true"
            aria-autocomplete="list"
          />
          <kbd>↑ ↓</kbd>
          <kbd>Enter</kbd>
          <kbd>Esc</kbd>
        </label>
        {index?.errors.length ? (
          <p class="af-command-palette-status" role="status">
            Some sources are unavailable: {index.errors.join("; ")}
            <button type="button" onClick={onRefresh}>
              Refresh results
            </button>
          </p>
        ) : null}
        {index?.statuses.length ? (
          <p class="af-command-palette-status" role="status">
            Source coverage: {index.statuses.join("; ")}
          </p>
        ) : null}
        {selectionIssue && (
          <p class="af-command-palette-status" role="alert">
            {selectionIssue}{" "}
            <button type="button" onClick={onRefresh}>
              Refresh results
            </button>
          </p>
        )}
        {!index ? (
          <p class="af-command-palette-status" role="status">
            Refreshing verified results…
          </p>
        ) : rows.length ? (
          <div
            id="af-command-palette-results"
            role="listbox"
            aria-label="Palette results"
          >
            {rows.map((row, position) => (
              <div
                key={`${row.kind}:${row.projectId}:${row.id}`}
                class={position === active ? "is-active" : ""}
                id={`af-palette-${position}`}
                role="option"
                aria-selected={position === active}
                aria-disabled={!!row.unavailable}
                tabIndex={-1}
                onMouseEnter={() => setActive(position)}
                onClick={() => choose(row)}
              >
                <span>
                  <strong>{row.label}</strong>
                  <small>{row.detail}</small>
                </span>
                {row.kind === "slash-command" &&
                row.intent?.kind === "slash-command" ? (
                  <code>{row.intent.argumentHint}</code>
                ) : (
                  <kbd>↵</kbd>
                )}
                {row.unavailable && <small>{row.unavailable}</small>}
              </div>
            ))}
          </div>
        ) : (
          <p class="af-command-palette-status" role="status">
            {query.trim()
              ? "No matching results."
              : "No recent items yet. Start typing to search."}
          </p>
        )}
      </div>
    </Dialog>
  );
}
