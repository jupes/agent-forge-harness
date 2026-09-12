import type { ComponentChildren, JSX } from "preact";

export interface StatCardProps {
  label: ComponentChildren;
  value: ComponentChildren;
  /** Small qualifier beside the number ("unblocked", "+3 today"). */
  note?: ComponentChildren;
  tone?: "neutral" | "accent" | "muted";
  class?: string;
}

/** A single headline number with its label. */
export function StatCard({
  label,
  value,
  note,
  tone = "neutral",
  class: className,
}: StatCardProps): JSX.Element {
  return (
    <div
      class={["af-stat", `af-stat-${tone}`, className]
        .filter(Boolean)
        .join(" ")}
    >
      <p class="af-stat-label">{label}</p>
      <p class="af-stat-value">
        {value}
        {note !== undefined ? <span class="af-stat-note">{note}</span> : null}
      </p>
    </div>
  );
}
