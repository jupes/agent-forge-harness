import type { ComponentChildren, JSX } from "preact";

export interface CardProps {
  children?: ComponentChildren;
  /** Small uppercase accent line above the title. */
  kicker?: ComponentChildren;
  title?: ComponentChildren;
  /** Heading level for the title — pick the one the page outline needs. */
  headingLevel?: 2 | 3 | 4;
  /** Right-aligned controls in the card header. */
  actions?: ComponentChildren;
  class?: string;
}

/** A surface-filled content panel. */
export function Card({
  children,
  kicker,
  title,
  headingLevel = 3,
  actions,
  class: className,
}: CardProps): JSX.Element {
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const hasHeader =
    kicker !== undefined || title !== undefined || actions !== undefined;

  return (
    <section class={["af-card", className].filter(Boolean).join(" ")}>
      {hasHeader ? (
        <header class="af-card-header">
          <div>
            {kicker !== undefined ? (
              <p class="af-card-kicker">{kicker}</p>
            ) : null}
            {title !== undefined ? (
              <Heading class="af-card-title">{title}</Heading>
            ) : null}
          </div>
          {actions !== undefined ? (
            <div class="af-card-actions">{actions}</div>
          ) : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}
