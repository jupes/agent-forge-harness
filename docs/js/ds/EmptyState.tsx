import type { ComponentChildren, JSX } from "preact";

export interface EmptyStateProps {
  title: ComponentChildren;
  /** What to do about it — a command, a link, a next step. */
  hint?: ComponentChildren;
  /** Announce politely; use when this replaces content that was loading. */
  live?: boolean;
  children?: ComponentChildren;
  class?: string;
}

/** The "nothing here yet, and here's why" panel. */
export function EmptyState({
  title,
  hint,
  live,
  children,
  class: className,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      class={["af-empty", className].filter(Boolean).join(" ")}
      aria-live={live ? "polite" : undefined}
    >
      <p class="af-empty-title">{title}</p>
      {hint !== undefined ? <p class="af-empty-hint">{hint}</p> : null}
      {children}
    </div>
  );
}
