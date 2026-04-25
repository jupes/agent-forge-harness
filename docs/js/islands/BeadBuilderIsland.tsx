import { BEAD_PRIORITIES, BEAD_TYPES, buildBdCreateCommand } from "@docs/bead-builder";
import { useEffect, useRef, useState } from "preact/hooks";

type ModalState =
  | { open: false }
  | { open: true; title: string; bodyHtml: string; fallbackText: string | null };

export function BeadBuilderIsland() {
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

  function openModal(messageHtml: string, fallbackText: string | null, titleText?: string) {
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

  function onBackdropClick() {
    closeModal();
  }

  function onModalKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") closeModal();
  }

  const showFallback = modal.open && modal.fallbackText != null && modal.fallbackText.length > 0;

  return (
    <div>
      <p
        className="sb-lead"
        style={{ color: "var(--text-muted)", maxWidth: "42rem", marginBottom: "1.5rem", lineHeight: 1.55 }}
      >
        Describe the bead you want to file. On submit we build a ready-to-paste <code>bd create</code> command and copy
        it to your clipboard — run it in a terminal that has <code>bd</code> on <code>PATH</code>.
      </p>
      <div className="skill-form-card" id="bead-form-card">
        <form ref={formRef} id="bead-builder-form" className="skill-form" noValidate onSubmit={onSubmit}>
          <div className="sb-field">
            <label htmlFor="bb-title">
              Title <span className="sb-req">*</span>
            </label>
            <input
              id="bb-title"
              name="title"
              type="text"
              required
              placeholder="Short, imperative title (becomes --title)"
              autoComplete="off"
            />
          </div>
          <div className="sb-field">
            <label htmlFor="bb-type">Type</label>
            <select id="bb-type" name="type" defaultValue="task">
              {BEAD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <span className="sb-hint">
              Choose <code>bug</code> for defects, <code>feature</code> for net-new capability, <code>chore</code> for
              maintenance, <code>task</code> otherwise.
            </span>
          </div>
          <div className="sb-field">
            <label htmlFor="bb-priority">Priority</label>
            <select id="bb-priority" name="priority" defaultValue="P2">
              {BEAD_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <span className="sb-hint">
              Follow <code>.claude/skills/beads-priority-assignment/SKILL.md</code>. Default <strong>P2</strong> when
              the rubric is silent.
            </span>
          </div>
          <div className="sb-field">
            <label htmlFor="bb-repo">Repo</label>
            <input id="bb-repo" name="repo" type="text" defaultValue="." placeholder="." autoComplete="off" />
            <span className="sb-hint">
              <code>.</code> for the harness root; <code>./repos/&lt;name&gt;</code> for a registered sub-repo.
            </span>
          </div>
          <div className="sb-field">
            <label htmlFor="bb-description">Description</label>
            <textarea
              id="bb-description"
              name="description"
              rows={4}
              placeholder="Context, links, reproduction steps, etc. Newlines become \n in the command."
            />
          </div>
          <div className="sb-field">
            <label htmlFor="bb-ac">Acceptance criteria</label>
            <textarea
              id="bb-ac"
              name="acceptanceCriteria"
              rows={4}
              placeholder="One per line. Each non-empty line becomes a separate --ac flag."
            />
          </div>
          <div className="sb-field">
            <label htmlFor="bb-labels">Labels</label>
            <input id="bb-labels" name="labels" type="text" placeholder="Comma-separated, e.g. dashboard,ui" autoComplete="off" />
          </div>
          <div className="sb-actions">
            <button type="button" className="sb-clear" id="bb-clear" onClick={onClear}>
              Clear form
            </button>
            <button type="submit" className="sb-submit" id="bb-submit" disabled={submitting}>
              <span className="sb-submit-label">Build command &amp; copy</span>
              <span className="sb-submit-spinner" aria-hidden="true" />
            </button>
          </div>
        </form>
      </div>
      <div
        id="bb-modal"
        className={"sb-modal" + (modal.open ? " is-open" : "")}
        aria-hidden={modal.open ? "false" : "true"}
        onKeyDown={onModalKeyDown}
      >
        <div className="sb-modal-backdrop" tabIndex={-1} onClick={onBackdropClick} />
        <div className="sb-modal-panel" role="dialog" aria-modal="true" aria-labelledby="bb-modal-title">
          <h2 id="bb-modal-title" className="sb-modal-title">
            {modal.open ? modal.title : ""}
          </h2>
          {modal.open ? (
            <p id="bb-modal-body" className="sb-modal-body" dangerouslySetInnerHTML={{ __html: modal.bodyHtml }} />
          ) : (
            <p id="bb-modal-body" className="sb-modal-body" />
          )}
          <p className="sb-modal-hint">
            Paste the command into a terminal where <code>bd</code> is installed. The new id will print on stdout.
          </p>
          <div id="bb-modal-fallback" className="sb-modal-fallback" hidden={!showFallback}>
            <label>Copy manually:</label>
            <textarea id="bb-modal-textarea" ref={modalTextareaRef} readOnly rows={6} />
          </div>
          <button type="button" className="sb-modal-close" id="bb-modal-close" ref={modalCloseRef} onClick={closeModal}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
