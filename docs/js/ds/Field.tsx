import type { ComponentChildren, JSX } from "preact";

export interface FieldProps {
  /** Visible label text. Always present — placeholders are not labels. */
  label: ComponentChildren;
  /** Id of the control this labels; also derives the hint's id. */
  id: string;
  children: ComponentChildren;
  required?: boolean;
  hint?: ComponentChildren;
  class?: string;
}

/** Label + control + optional hint, wired together by id. */
export function Field({
  label,
  id,
  children,
  required,
  hint,
  class: className,
}: FieldProps): JSX.Element {
  return (
    <div class={["af-field", className].filter(Boolean).join(" ")}>
      <label for={id} class="af-field-label">
        {label}
        {required ? (
          <abbr class="af-field-required" title="required">
            *
          </abbr>
        ) : null}
      </label>
      {children}
      {hint !== undefined ? (
        <p id={`${id}-hint`} class="af-field-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

interface ControlBase {
  id: string;
  /** Id of the hint element describing this control. */
  describedBy?: string;
  class?: string;
  required?: boolean;
  disabled?: boolean;
}

export interface InputProps extends ControlBase {
  type?: string;
  value?: string | number;
  placeholder?: string;
  onInput?: JSX.InputEventHandler<HTMLInputElement>;
  onKeyDown?: JSX.KeyboardEventHandler<HTMLInputElement>;
  autocomplete?: string;
  inputmode?: JSX.HTMLAttributes<HTMLInputElement>["inputmode"];
}

export function Input({
  id,
  describedBy,
  class: className,
  type = "text",
  ...rest
}: InputProps): JSX.Element {
  return (
    <input
      id={id}
      type={type}
      class={["af-input", className].filter(Boolean).join(" ")}
      aria-describedby={describedBy}
      {...rest}
    />
  );
}

export interface TextareaProps extends ControlBase {
  value?: string;
  placeholder?: string;
  rows?: number;
  onInput?: JSX.InputEventHandler<HTMLTextAreaElement>;
}

export function Textarea({
  id,
  describedBy,
  class: className,
  ...rest
}: TextareaProps): JSX.Element {
  return (
    <textarea
      id={id}
      class={["af-input", className].filter(Boolean).join(" ")}
      aria-describedby={describedBy}
      {...rest}
    />
  );
}

export interface SelectProps extends ControlBase {
  value?: string;
  children: ComponentChildren;
  onChange?: JSX.GenericEventHandler<HTMLSelectElement>;
}

export function Select({
  id,
  describedBy,
  class: className,
  children,
  ...rest
}: SelectProps): JSX.Element {
  return (
    <select
      id={id}
      class={["af-input", className].filter(Boolean).join(" ")}
      aria-describedby={describedBy}
      {...rest}
    >
      {children}
    </select>
  );
}
