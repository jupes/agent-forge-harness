import {
  BEAD_PRIORITIES,
  BEAD_TYPES,
  buildBdCreateCommand,
} from "@docs/bead-builder";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../ds/Button";
import { Card } from "../ds/Card";
import { Dialog } from "../ds/Dialog";
import { Field, Input, Select, Textarea } from "../ds/Field";

type ModalState =
  | { open: false }
  | {
      open: true;
      title: string;
      bodyHtml: string;
      fallbackText: string | null;
    };

export function BeadBuilderIsland() {
  const formRef = useRef<HTMLFormElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const [modal, setModal] = useState<ModalState>({ open: false });
  const [submitting, setSubmitting] = useState(false);

  // Select the whole command so Ctrl+C / Cmd+C copies it straight away. Child
  // effects run first, so the dialog is already shown when this runs.
  useEffect(() => {
    if (!modal.open || !modal.fallbackText) return;
    const textarea = fallbackRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.select();
  }, [modal]);

  function closeModal() {
    setModal({ open: false });
  }

  function openModal(
    messageHtml: string,
    fallbackText: string | null,
    titleText?: string,
  ) {
    setModal({
      open: true,
      title: titleText ?? "Copied to clipboard",
      bodyHtml: messageHtml,
      fallbackText,
    });
  }

  async function onSubmit(e: Event) {
    e.preventDefault();
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);
    const title = String(fd.get("title") ?? "").trim();
    if (!title) {
      form.reportValidity();
      return;
    }

    const data = {
      title,
      type: String(fd.get("type") ?? "task"),
      priority: String(fd.get("priority") ?? "P2"),
      repo: String(fd.get("repo") ?? "."),
      description: String(fd.get("description") ?? ""),
      acceptanceCriteria: String(fd.get("acceptanceCriteria") ?? ""),
      labels: String(fd.get("labels") ?? ""),
    };

    const command = buildBdCreateCommand(data);
    setSubmitting(true);
    form.classList.add("is-submitting");
    try {
      await new Promise<void>((r) => {
        setTimeout(r, 320);
      });

      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(command);
          copied = true;
        }
      } catch {
        copied = false;
      }

      const card = form.closest("#bead-form-card");
      if (card instanceof HTMLElement) {
        card.classList.add("is-success-flash");
        const onAnim = () => {
          card.removeEventListener("animationend", onAnim);
          card.classList.remove("is-success-flash");
        };
        card.addEventListener("animationend", onAnim, { once: true });
      }

      if (copied) {
        openModal(
          "The <code>bd create</code> command is on your clipboard. <strong>Paste it into a terminal</strong> where <code>bd</code> is installed; it will print the new issue id.",
          command,
          "Copied to clipboard",
        );
      } else {
        openModal(
          "Clipboard was not available (browser permissions or non-secure context). <strong>Copy the command below</strong> and run it in your terminal.",
          command,
          "Copy this command",
        );
      }
    } finally {
      form.classList.remove("is-submitting");
      setSubmitting(false);
    }
  }

  function onClear() {
    closeModal();
    const form = formRef.current;
    if (form) {
      form.reset();
      form.classList.remove("is-submitting");
    }
    setSubmitting(false);
    const first = form?.querySelector("#bb-title");
    if (first instanceof HTMLElement) first.focus();
  }

  const fallbackText =
    modal.open && modal.fallbackText ? modal.fallbackText : "";

  return (
    <>
      <Card
        id="bead-form-card"
        title="Compose a bd create command"
        headingLevel={2}
        class="af-builder"
      >
        <p class="af-prose af-muted">
          Describe the bead you want to file. On submit we build a
          ready-to-paste <code>bd create</code> command and copy it to your
          clipboard — run it in a terminal that has <code>bd</code> on{" "}
          <code>PATH</code>.
        </p>

        <form
          ref={formRef}
          id="bead-builder-form"
          noValidate
          onSubmit={onSubmit}
        >
          <div class="af-form-grid">
            <Field label="Title" id="bb-title" required class="af-form-wide">
              <Input
                id="bb-title"
                name="title"
                required
                placeholder="Short, imperative title (becomes --title)"
                autocomplete="off"
              />
            </Field>

            <Field
              label="Type"
              id="bb-type"
              hint="bug for defects, feature for net-new capability, chore for maintenance, task otherwise."
            >
              <Select
                id="bb-type"
                name="type"
                value="task"
                describedBy="bb-type-hint"
              >
                {BEAD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Priority"
              id="bb-priority"
              hint="Follow .claude/skills/beads-priority-assignment/SKILL.md. Default P2 when the rubric is silent."
            >
              <Select
                id="bb-priority"
                name="priority"
                value="P2"
                describedBy="bb-priority-hint"
              >
                {BEAD_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Repo"
              id="bb-repo"
              hint="`.` for the harness root; ./repos/<name> for a registered sub-repo."
            >
              <Input
                id="bb-repo"
                name="repo"
                defaultValue="."
                placeholder="."
                autocomplete="off"
                describedBy="bb-repo-hint"
              />
            </Field>

            <Field label="Labels" id="bb-labels">
              <Input
                id="bb-labels"
                name="labels"
                placeholder="Comma-separated, e.g. dashboard,ui"
                autocomplete="off"
              />
            </Field>

            <Field label="Description" id="bb-description" class="af-form-wide">
              <Textarea
                id="bb-description"
                name="description"
                rows={4}
                placeholder="Context, links, reproduction steps. Newlines become \n in the command."
              />
            </Field>

            <Field
              label="Acceptance criteria"
              id="bb-ac"
              class="af-form-wide"
              hint="One per line. Each non-empty line becomes a separate --acceptance flag."
            >
              <Textarea
                id="bb-ac"
                name="acceptanceCriteria"
                rows={4}
                placeholder="Something verifiable, one per line"
                describedBy="bb-ac-hint"
              />
            </Field>
          </div>

          <div class="af-form-actions">
            <Button onClick={onClear}>Clear form</Button>
            <button
              ref={submitRef}
              type="submit"
              class="af-btn af-btn-primary"
              disabled={submitting}
            >
              {submitting ? "Building…" : "Build command & copy"}
            </button>
          </div>
        </form>
      </Card>

      <Dialog
        open={modal.open}
        title={modal.open ? modal.title : ""}
        onClose={closeModal}
        titleId="bb-modal-title"
        initialFocus={fallbackText ? "content" : "close"}
        returnFocusRef={submitRef}
        actions={<Button onClick={closeModal}>Close</Button>}
      >
        {/* Body copy is authored here, not user input. */}
        {modal.open ? (
          <p dangerouslySetInnerHTML={{ __html: modal.bodyHtml }} />
        ) : null}
        <p class="af-muted">
          Paste the command into a terminal where <code>bd</code> is installed.
          The new id will print on stdout.
        </p>
        {fallbackText ? (
          <Field label="Copy manually" id="bb-modal-textarea">
            <Textarea
              id="bb-modal-textarea"
              textareaRef={fallbackRef}
              value={fallbackText}
              readOnly
              autofocus
              rows={6}
              class="af-mono"
            />
          </Field>
        ) : null}
      </Dialog>
    </>
  );
}
