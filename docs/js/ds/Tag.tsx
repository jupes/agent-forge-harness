import type { ComponentChildren, JSX } from "preact";

export type TagTone = "neutral" | "accent" | "outline" | "muted";

export interface TagProps {
  children?: ComponentChildren;
  tone?: TagTone;
  title?: string;
  class?: string;
}

/** A small label tinted from the ramps — statuses, priorities, counts. */
export function Tag({
  children,
  tone = "neutral",
  title,
  class: className,
}: TagProps): JSX.Element {
  return (
    <span
      class={["af-tag", `af-tag-${tone}`, className].filter(Boolean).join(" ")}
      title={title}
    >
      {children}
    </span>
  );
}
