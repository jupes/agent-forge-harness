import { buildAuthoringPrompt } from "@docs/skill-builder";
import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../ds/Button";
import { Card } from "../ds/Card";
import { Dialog } from "../ds/Dialog";
import { Field, Input, Textarea } from "../ds/Field";

type ModalState =
  | { open: false }
  | {
      open: true;
      title: string;
      bodyHtml: string;
      fallbackText: string | null;
    };

export function SkillBuilderIsland() {
  const formRef = useRef<HTMLFormElement>(null);
  const modalCloseRef = useRef<HTMLButtonElement>(null);
  const modalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [modal, setModal] = useState<ModalState>({ open: false });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!modal.open) return;
    const id = requestAnimationFrame(() => {
      modalCloseRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [modal]);

  useEffect(() => {
    if (!modal.open || !modalTextareaRef.current) return;
    if (modal.fallbackText) {
      modalTextareaRef.current.value = modal.fallbackText;
      modalTextareaRef.current.select();
    } else {
      modalTextareaRef.current.value = "";
    }
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
    const skillName = String(fd.get("skillName") ?? "").trim();
    const description = String(fd.get("description") ?? "").trim();
    if (!skillName || !description) {
      form.reportValidity();
      return;
    }

    const data = {
      skillName,
      description,
      whenToUse: String(fd.get("whenToUse") ?? ""),
      workflow: String(fd.get("workflow") ?? ""),
      additionalNotes: String(fd.get("additionalNotes") ?? ""),
    };

    const prompt = buildAuthoringPrompt(data);
    setSubmitting(true);
    form.classList.add("is-submitting");
    try {
      await new Promise<void>((r) => {
        setTimeout(r, 480);
      });

      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(prompt);
          copied = true;
        }
      } catch {
        copied = false;
      }

      const card = form.closest("#skill-form-card");
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
          "The full authoring prompt is on your clipboard. <strong>Give it to your agent</strong> in Claude Code, Cursor, or any tool that can read the repo and follow <code>@.claude/skills/authoring-agent-skills</code>.",
          null,
          "Copied to clipboard",
        );
      } else {
        openModal(
          "Clipboard was not available (browser permissions or non-secure context). <strong>Copy the prompt below</strong> and give it to your agent.",
          prompt,
          "Copy this prompt",
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
    const first = form?.querySelector("#sb-skill-name");
    if (first instanceof HTMLElement) first.focus();
  }

  function onBackdropClick() {
    closeModal();
  }

  function onModalKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") closeModal();
  }

  const fallbackText =
    modal.open && modal.fallbackText ? modal.fallbackText : "";

  return (
    <>
      <Card
        title="Compose a skill authoring prompt"
        headingLevel={2}
        class="af-builder"
      >
        <p class="af-prose af-muted">
          Describe the skill you want. On submit we build a single prompt for
          your agent (including a directive to use{" "}
          <code>@.claude/skills/authoring-agent-skills</code>) and copy it to
          the clipboard.
        </p>

        <form
          ref={formRef}
          id="skill-builder-form"
          noValidate
          onSubmit={onSubmit}
        >
          <div class="af-form-grid">
            <Field
              label="Skill name"
              id="sb-skill-name"
              required
              class="af-form-wide"
              hint="Becomes a kebab-case folder under .claude/skills/ in the prompt (spaces and punctuation are normalized)."
            >
              <Input
                id="sb-skill-name"
                name="skillName"
                required
                placeholder="e.g. deploy-staging"
                autocomplete="off"
                describedBy="sb-skill-name-hint"
              />
            </Field>

            <Field
              label="One-line description"
              id="sb-description"
              required
              class="af-form-wide"
            >
              <Input
                id="sb-description"
                name="description"
                required
                placeholder="Short one-line summary (top of SKILL.md)"
              />
            </Field>

            <Field
              label="When to use this skill"
              id="sb-when"
              class="af-form-wide"
            >
              <Textarea
                id="sb-when"
                name="whenToUse"
                rows={3}
                placeholder="Triggers, contexts, or roles that should load this skill…"
              />
            </Field>

            <Field
              label="Workflow / steps to encode"
              id="sb-workflow"
              class="af-form-wide"
            >
              <Textarea
                id="sb-workflow"
                name="workflow"
                rows={6}
                placeholder="Numbered or bulleted steps you want the agent to follow…"
              />
            </Field>

            <Field
              label="Additional constraints or notes"
              id="sb-notes"
              class="af-form-wide"
            >
              <Textarea
                id="sb-notes"
                name="additionalNotes"
                rows={3}
                placeholder="e.g. JSON output from scripts, idempotency, error handling…"
              />
            </Field>
          </div>

          <div class="af-form-actions">
            <Button onClick={onClear}>Clear form</Button>
            <button
              type="submit"
              class="af-btn af-btn-primary"
              disabled={submitting}
            >
              {submitting ? "Generating…" : "Generate prompt & copy"}
            </button>
          </div>
        </form>
      </Card>

      <Dialog
        open={modal.open}
        title={modal.open ? modal.title : ""}
        onClose={closeModal}
        titleId="sb-modal-title"
        actions={<Button onClick={closeModal}>Close</Button>}
      >
        {modal.open ? (
          // Body copy is authored here, not user input.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: fixed local strings, no user or network content reaches this.
          <p dangerouslySetInnerHTML={{ __html: modal.bodyHtml }} />
        ) : null}
        <p class="af-muted">
          Paste the prompt into your coding agent. It will scaffold the skill
          folder and files for you.
        </p>
        {fallbackText ? (
          <Field label="Copy manually" id="sb-modal-textarea">
            <Textarea
              id="sb-modal-textarea"
              defaultValue={fallbackText}
              rows={6}
              class="af-mono"
            />
          </Field>
        ) : null}
      </Dialog>
    </>
  );
}
