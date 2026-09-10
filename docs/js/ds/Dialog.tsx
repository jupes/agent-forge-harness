import type { ComponentChildren, JSX } from "preact";
import { Icon } from "./Icon";

export interface DialogProps {
  open: boolean;
  title: ComponentChildren;
  onClose: () => void;
  children: ComponentChildren;
  /** Rendered in the footer, right-aligned. */
  actions?: ComponentChildren;
  /**
   * Id for the title element the dialog is labelled by. The default is fine
   * while only one dialog is open at a time; pass one if two can coexist.
   */
  titleId?: string;
  class?: string;
}

/**
 * A modal dialog over a dismissing backdrop.
 *
 * Deliberately hook-free: the panel takes focus via `autofocus` and the title
 * id is a prop rather than `useId()`, which keeps the whole component a pure
 * function of its props — renderable, and testable, without a DOM.
 *
 * Closes on Escape and on backdrop click.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  actions,
  titleId = "af-dialog-title",
  class: className,
}: DialogProps): JSX.Element | null {
  if (!open) return null;

  return (
    <div
      class="af-dialog-backdrop"
      onClick={(event) => {
        // Only a click on the backdrop itself dismisses — not one that
        // bubbled up from inside the panel.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        class={["af-dialog", className].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        autofocus
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <header class="af-dialog-header">
          <h2 id={titleId} class="af-dialog-title">
            {title}
          </h2>
          <button
            type="button"
            class="af-dialog-close"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <Icon name="x" />
          </button>
        </header>
        <div class="af-dialog-body">{children}</div>
        {actions !== undefined ? (
          <footer class="af-dialog-actions">{actions}</footer>
        ) : null}
      </div>
    </div>
  );
}
