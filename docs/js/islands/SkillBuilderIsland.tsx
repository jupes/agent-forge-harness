import { buildAuthoringPrompt } from "@docs/skill-builder";
import { useEffect, useRef, useState } from "preact/hooks";

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

  const showFallback =
    modal.open && modal.fallbackText != null && modal.fallbackText.length > 0;

  return (
    <div>
      <p
        className="sb-lead"
        style={{
          color: "var(--text-muted)",
          maxWidth: "42rem",
          marginBottom: "1.5rem",
          lineHeight: 1.55,
        }}
      >
        Describe the skill you want. On submit we build a single prompt for your
        agent (including a directive to use{" "}
        <code>@.claude/skills/authoring-agent-skills</code>) and copy it to the
        clipboard.
      </p>
      <div className="skill-form-card" id="skill-form-card">
        <form
          ref={formRef}
          id="skill-builder-form"
          className="skill-form"
          noValidate
          onSubmit={onSubmit}
        >
          <div className="sb-field">
            <label htmlFor="sb-skill-name">
              Skill name <span className="sb-req">*</span>
            </label>
            <input
              id="sb-skill-name"
              name="skillName"
              type="text"
              required
              placeholder="e.g. deploy-staging"
              autoComplete="off"
            />
            <span className="sb-hint">
              Becomes a kebab-case folder under <code>.claude/skills/</code> in
              the prompt (spaces and punctuation are normalized).
            </span>
          </div>
          <div className="sb-field">
            <label htmlFor="sb-description">
              One-line description <span className="sb-req">*</span>
            </label>
            <input
              id="sb-description"
              name="description"
              type="text"
              required
              placeholder="Short one-line summary (top of SKILL.md)"
            />
          </div>
          <div className="sb-field">
            <label htmlFor="sb-when">When to use this skill</label>
            <textarea
              id="sb-when"
              name="whenToUse"
              rows={3}
              placeholder="Triggers, contexts, or roles that should load this skill…"
            />
          </div>
          <div className="sb-field">
            <label htmlFor="sb-workflow">Workflow / steps to encode</label>
            <textarea
              id="sb-workflow"
              name="workflow"
              rows={6}
              placeholder="Numbered or bulleted steps you want the agent to follow…"
            />
          </div>
          <div className="sb-field">
            <label htmlFor="sb-notes">Additional constraints or notes</label>
            <textarea
              id="sb-notes"
              name="additionalNotes"
              rows={3}
              placeholder="e.g. JSON output from scripts, idempotency, error handling…"
            />
          </div>
          <div className="sb-actions">
            <button
              type="button"
              className="sb-clear"
              id="sb-clear"
              onClick={onClear}
            >
              Clear form
            </button>
            <button
              type="submit"
              className="sb-submit"
              id="sb-submit"
              disabled={submitting}
            >
              <span className="sb-submit-label">
                Generate prompt &amp; copy
              </span>
              <span className="sb-submit-spinner" aria-hidden="true" />
            </button>
          </div>
        </form>
      </div>
      <div
        id="sb-modal"
        className={"sb-modal" + (modal.open ? " is-open" : "")}
        aria-hidden={modal.open ? "false" : "true"}
        onKeyDown={onModalKeyDown}
      >
        <div
          className="sb-modal-backdrop"
          tabIndex={-1}
          onClick={onBackdropClick}
        />
        <div
          className="sb-modal-panel"
          role="dialog"
          aria-modal="true"
          aria-labelledby="sb-modal-title"
        >
          <h2 id="sb-modal-title" className="sb-modal-title">
            {modal.open ? modal.title : ""}
          </h2>
          {modal.open ? (
            <p
              id="sb-modal-body"
              className="sb-modal-body"
              dangerouslySetInnerHTML={{ __html: modal.bodyHtml }}
            />
          ) : (
            <p id="sb-modal-body" className="sb-modal-body" />
          )}
          <p className="sb-modal-hint">
            Paste that prompt into your coding agent so it can create the skill
            using the authoring meta-skill.
          </p>
          <div
            id="sb-modal-fallback"
            className="sb-modal-fallback"
            hidden={!showFallback}
          >
            <label>Copy manually:</label>
            <textarea
              id="sb-modal-textarea"
              ref={modalTextareaRef}
              readOnly
              rows={8}
            />
          </div>
          <button
            type="button"
            className="sb-modal-close"
            id="sb-modal-close"
            ref={modalCloseRef}
            onClick={closeModal}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
