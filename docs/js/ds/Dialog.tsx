import type { ComponentChildren, JSX, RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
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
  /**
   * Where focus lands on open. `"close"` focuses the close button; `"content"`
   * leaves it to an `autofocus` element inside `children`.
   */
  initialFocus?: "close" | "content";
  /**
   * The control to refocus on close. The browser restores focus to whatever
   * was focused when the dialog opened — but if the opener was disabled while
   * work ran (a submit button, say), that is `<body>`, so name it explicitly.
   */
  returnFocusRef?: RefObject<HTMLElement>;
  class?: string;
}

export interface DialogViewProps extends DialogProps {
  dialogRef?: RefObject<HTMLDialogElement>;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/**
 * Keep Tab and Shift+Tab cycling inside the dialog.
 *
 * `showModal()` makes the page behind inert, but at either end of the dialog
 * the browser still moves focus out of the document to its own chrome.
 */
function containTab(event: KeyboardEvent, root: HTMLElement): void {
  if (event.key !== "Tab") return;
  const items = Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE),
  ).filter((el) => el.getClientRects().length > 0);
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  const outside = !root.contains(active);
  if (event.shiftKey && (active === first || outside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || outside)) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * The dialog's markup, as a pure function of its props.
 *
 * Split from `Dialog` so structure stays testable without a DOM. Behavior that
 * needs a real browser — the modal top layer, inert background, contained Tab
 * order, focus return — is verified in `tests/e2e/a11y.spec.ts`.
 */
export function DialogView({
  open,
  title,
  onClose,
  children,
  actions,
  titleId = "af-dialog-title",
  initialFocus = "close",
  class: className,
  dialogRef,
}: DialogViewProps): JSX.Element {
  return (
    <dialog
      {...(dialogRef ? { ref: dialogRef } : {})}
      class={["af-dialog", className].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Escape. Keep component state the source of truth rather than letting
        // the element close itself underneath it.
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        // The browser can still close a dialog on its own (e.g. repeated
        // Escape without user activation); bring state back in line.
        if (open) onClose();
      }}
      onClick={(event) => {
        // A click on the backdrop targets the <dialog> itself; clicks inside
        // the panel target its descendants.
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => containTab(event, event.currentTarget)}
    >
      {open ? (
        <div class="af-dialog-panel">
          <header class="af-dialog-header">
            <h2 id={titleId} class="af-dialog-title">
              {title}
            </h2>
            <button
              type="button"
              class="af-dialog-close"
              aria-label="Close dialog"
              autofocus={initialFocus === "close"}
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
      ) : null}
    </dialog>
  );
}

/**
 * A modal dialog.
 *
 * Built on the native `<dialog>` and `showModal()`, which is what actually
 * delivers modality: the rest of the document becomes inert, so nothing behind
 * it can take focus. Setting `aria-modal` on a plain element only *announces*
 * modality — it never contained focus.
 */
export function Dialog(props: DialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const wasOpen = useRef(false);
  const { open, returnFocusRef } = props;

  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    if (open) {
      if (!node.open) node.showModal();
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    // close() while the element is still in the document restores focus to
    // the opener; the explicit ref covers an opener that was disabled.
    if (node.open) node.close();
    const target = returnFocusRef?.current;
    if (target?.isConnected) target.focus();
  }, [open, returnFocusRef]);

  useEffect(
    () => () => {
      if (dialogRef.current?.open) dialogRef.current.close();
    },
    [],
  );

  return <DialogView {...props} dialogRef={dialogRef} />;
}
