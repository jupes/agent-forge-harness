import type { JSX } from "preact";
import { ICON_PATHS, type IconName } from "./icon-paths";

export type { IconName };

export interface IconProps {
  name: IconName;
  /** Square edge in px. Interface icons sit at 14–16; 20+ reads as a graphic. */
  size?: number;
  /**
   * Accessible name. Omit for icons that sit beside their own label — the
   * default is `aria-hidden`, which keeps screen readers from announcing the
   * same thing twice.
   */
  label?: string;
  class?: string;
}

/**
 * A Phosphor glyph, inlined from committed path data.
 *
 * The glyph inherits `currentColor`, so color it by setting `color` on any
 * ancestor rather than passing a fill.
 */
export function Icon({
  name,
  size = 16,
  label,
  class: className,
}: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 256 256"
      width={size}
      height={size}
      fill="currentColor"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : "true"}
      class={className}
    >
      {/* A real <title> alongside aria-label: the widest support for naming an
          inline SVG, and what static a11y lint can actually see. */}
      {label ? <title>{label}</title> : null}
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
