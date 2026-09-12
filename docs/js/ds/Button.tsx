import type { ComponentChildren, JSX } from "preact";
import { Icon, type IconName } from "./Icon";

export type ButtonVariant = "primary" | "secondary" | "ghost";

export interface ButtonProps {
  children?: ComponentChildren;
  /** Nocturne outlines the primary action; it is never a solid fill. */
  variant?: ButtonVariant;
  /** Decorative leading glyph. The button's text is its accessible name. */
  icon?: IconName;
  /** Render as an anchor instead of a button (same styling). */
  href?: string;
  onClick?: JSX.MouseEventHandler<HTMLElement>;
  disabled?: boolean;
  title?: string;
  class?: string;
  "aria-label"?: string;
  "aria-expanded"?: boolean;
  "aria-current"?: JSX.AriaAttributes["aria-current"];
}

export function Button({
  children,
  variant = "secondary",
  icon,
  href,
  onClick,
  disabled,
  title,
  class: className,
  ...aria
}: ButtonProps): JSX.Element {
  const classes = ["af-btn", `af-btn-${variant}`, className]
    .filter(Boolean)
    .join(" ");
  const inner = (
    <>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </>
  );

  if (href !== undefined) {
    return (
      <a href={href} class={classes} title={title} onClick={onClick} {...aria}>
        {inner}
      </a>
    );
  }

  return (
    <button
      type="button"
      class={classes}
      onClick={onClick}
      disabled={disabled}
      title={title}
      {...aria}
    >
      {inner}
    </button>
  );
}
