import type { JSX } from "preact";

export interface ProgressBarProps {
  value: number;
  max: number;
  /** Accessible name — a bare bar tells a screen-reader user nothing. */
  label: string;
  class?: string;
}

/** A determinate progress track. */
export function ProgressBar({
  value,
  max,
  label,
  class: className,
}: ProgressBarProps): JSX.Element {
  // An epic with no children would otherwise divide by zero.
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;

  return (
    <div
      class={["af-progress", className].filter(Boolean).join(" ")}
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
    >
      <span class="af-progress-fill" style={`width:${pct}%`} />
    </div>
  );
}
