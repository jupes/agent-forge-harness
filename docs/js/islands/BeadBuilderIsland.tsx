import {
  acceptanceText,
  BEAD_PRIORITIES,
  BEAD_TYPES,
  buildBdCreateCommand,
} from "@docs/bead-builder";
import { useEffect, useRef, useState } from "preact/hooks";
import { parseBeadsIssueId } from "../../../scripts/run-correlation";
import { Button } from "../ds/Button";
import { Card } from "../ds/Card";
import { Dialog } from "../ds/Dialog";
import { Field, Input, Select, Textarea } from "../ds/Field";
import { Tag } from "../ds/Tag";
import { statusLabel, statusTone } from "../issue-presentation";
import { BeadActions } from "./BeadActions";
import {
  applied,
  beadWrites,
  createState,
  NO_ROOM,
  useAwaiting,
  useBeadWrites,
  useCreated,
} from "./bead-writes";
import { CopyIdButton } from "./CopyIdButton";
import { NoticePointer } from "./PendingWrites";

type ModalState =
  | { open: false }
  | {
      open: true;
      title: string;
      bodyHtml: string;
      fallbackText: string | null;
    };

const DEFAULT_TYPE = "task";
const DEFAULT_PRIORITY = "P2";

export function BeadBuilderIsland() {
  const formRef = useRef<HTMLFormElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const fallbackRef = useRef<HTMLTextAreaElement>(null);
  const [modal, setModal] = useState<ModalState>({ open: false });
  const [submitting, setSubmitting] = useState(false);

  // Held here, not left to the DOM: this island re-renders while the form is
  // being filled, and a <select> given a fixed value is put back to it each time.
  const [type, setType] = useState(DEFAULT_TYPE);
  const [priority, setPriority] = useState(DEFAULT_PRIORITY);
  // What decides whether Create is offered. The inputs themselves stay the form's.
  const [labels, setLabels] = useState("");
  const [repo, setRepo] = useState(".");
  const [parent, setParent] = useState("");
  const [creating, setCreating] = useState(false);
  // An outcome nobody knows is not held here: the page's store keeps it.
  const [createResult, setCreateResult] = useState<{
    tone: "done" | "failed";
    message: string;
  } | null>(null);
  // Set before the first await: two presses in one turn of the event loop
  // arrive before the disabled state is drawn, and a second create is a second bead.
  const sending = useRef(false);

  const plane = useBeadWrites();
  const made = useCreated();
  const latest = made[0];
  // A create out from before this builder was mounted (it was left and come back to).
  const awaitedCreates = useAwaiting();
  // An answer that comes back after the builder is gone has nobody to tell.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The creates sent from here: the pointer to the list is for these.
  const [sentKeys] = useState(() => new Set<string>());

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

  const parentId = parent.trim();
  const parentIsAnId =
    parentId === "" || parseBeadsIssueId(parentId) === parentId;

  /** What the form holds, or null (and the browser's own message) when it has no title. */
  function read() {
    const form = formRef.current;
    if (!form) return null;
    const fd = new FormData(form);
    const title = String(fd.get("title") ?? "").trim();
    if (!title) {
      form.reportValidity();
      return null;
    }
    return {
      form,
      title,
      type,
      priority,
      repo: String(fd.get("repo") ?? "."),
      description: String(fd.get("description") ?? ""),
      acceptanceCriteria: String(fd.get("acceptanceCriteria") ?? ""),
      labels: String(fd.get("labels") ?? ""),
      // Only an id goes into the command or the request.
      parent: parentIsAnId ? parentId : "",
    };
  }

  function flash(form: HTMLFormElement) {
    const card = form.closest("#bead-form-card");
    if (!(card instanceof HTMLElement)) return;
    card.classList.add("is-success-flash");
    const onAnim = () => {
      card.removeEventListener("animationend", onAnim);
      card.classList.remove("is-success-flash");
    };
    card.addEventListener("animationend", onAnim, { once: true });
  }

  async function onSubmit(e: Event) {
    e.preventDefault();
    const data = read();
    if (!data) return;
    const { form } = data;

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

      flash(form);

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

  async function onCreate() {
    if (sending.current) return;
    const data = read();
    if (!data) return;
    const key = applied.begin({ action: "create", title: data.title });
    if (key === null) {
      setCreateResult({ tone: "failed", message: NO_ROOM });
      return;
    }
    sending.current = true;
    setCreating(true);
    setCreateResult(null);
    sentKeys.add(key);
    try {
      const outcome = await beadWrites.create({
        title: data.title,
        type: data.type,
        priority: data.priority,
        parent: data.parent,
        description: data.description,
        acceptance: acceptanceText(data.acceptanceCriteria),
      });
      if (outcome.ok) {
        applied.settle(key);
        applied.record(outcome.data, {
          created: {
            title: data.title,
            type: data.type,
            priority: data.priority,
            ...(data.parent ? { parent: data.parent } : {}),
          },
        });
        flash(data.form);
        setCreateResult({
          tone: "done",
          message: outcome.data.recorded
            ? `Created ${outcome.data.id}.`
            : `Created ${outcome.data.id}. The bead exists, but the ledger did not record it${
                outcome.data.recordError ? `: ${outcome.data.recordError}` : "."
              }`,
        });
      } else if (outcome.unknown) applied.unknown(key, outcome.error);
      else if (!mounted.current) applied.refused(key, outcome.error);
      else {
        applied.settle(key);
        setCreateResult({ tone: "failed", message: outcome.error });
      }
    } finally {
      sending.current = false;
      setCreating(false);
    }
  }

  function onClear() {
    closeModal();
    const form = formRef.current;
    if (form) {
      form.reset();
      form.classList.remove("is-submitting");
    }
    // `reset()` fires no input event, so what mirrors the form is reset with it.
    setType(DEFAULT_TYPE);
    setPriority(DEFAULT_PRIORITY);
    setLabels("");
    setRepo(".");
    setParent("");
    setCreateResult(null);
    setSubmitting(false);
    const first = form?.querySelector("#bb-title");
    if (first instanceof HTMLElement) first.focus();
  }

  const fallbackText =
    modal.open && modal.fallbackText ? modal.fallbackText : "";

  const served = plane?.available ? plane.options : null;
  const types = served?.types ?? BEAD_TYPES;
  const rubric = served?.priorities.find((option) => option.value === priority);
  const offer =
    plane === null
      ? { enabled: false, reason: "Looking for the local control plane…" }
      : !parentIsAnId
        ? { enabled: false, reason: "Parent is not a Beads issue id." }
        : createState(
            plane.available
              ? { available: true, labels, repo }
              : { available: false, reason: plane.reason, labels, repo },
          );
  const createReason = offer.enabled ? null : offer.reason;

  return (
    <>
      <Card
        id="bead-form-card"
        title="File a bead"
        headingLevel={2}
        class="af-builder"
      >
        <p class="af-prose af-muted">
          Describe the bead you want to file. <strong>Create bead</strong> files
          it in this checkout's tracker through the local control plane and
          shows the new id. <strong>Build command &amp; copy</strong> gives you
          a <code>bd create</code> command to paste into a terminal instead.
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
              hint="bug for defects, feature for net-new capability, chore for maintenance, epic for a body of work, task otherwise."
            >
              <Select
                id="bb-type"
                name="type"
                value={type}
                describedBy="bb-type-hint"
                onChange={(event) => setType(event.currentTarget.value)}
              >
                {types.map((known) => (
                  <option key={known} value={known}>
                    {known}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Priority"
              id="bb-priority"
              hint={
                rubric
                  ? `${rubric.tier}: ${rubric.meaning}.`
                  : "Follow .claude/skills/beads-priority-assignment/SKILL.md. Default P2 when the rubric is silent."
              }
            >
              <Select
                id="bb-priority"
                name="priority"
                value={priority}
                describedBy="bb-priority-hint"
                onChange={(event) => setPriority(event.currentTarget.value)}
              >
                {served
                  ? served.priorities.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.value} · {option.tier}
                      </option>
                    ))
                  : BEAD_PRIORITIES.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
              </Select>
            </Field>

            <Field
              label="Parent"
              id="bb-parent"
              hint={
                parentIsAnId
                  ? "Optional. The id of the epic or feature this bead belongs under."
                  : "This is not a Beads issue id; it is left out of the command, and Create is not offered."
              }
            >
              <Input
                id="bb-parent"
                name="parent"
                placeholder="e.g. the id of an epic"
                autocomplete="off"
                describedBy="bb-parent-hint"
                onInput={(event) => setParent(event.currentTarget.value)}
              />
            </Field>

            <Field
              label="Repo"
              id="bb-repo"
              hint="`.` for the harness itself. For a sub-repo, its name: the copied command starts the title with [<name>] and passes no --repo, since `.` is the only repository bd has registered. Copied command only."
            >
              <Input
                id="bb-repo"
                name="repo"
                defaultValue="."
                placeholder="."
                autocomplete="off"
                describedBy="bb-repo-hint"
                onInput={(event) => setRepo(event.currentTarget.value)}
              />
            </Field>

            <Field
              label="Labels"
              id="bb-labels"
              hint="Comma-separated. Copied command only."
            >
              <Input
                id="bb-labels"
                name="labels"
                placeholder="e.g. dashboard,ui"
                autocomplete="off"
                describedBy="bb-labels-hint"
                onInput={(event) => setLabels(event.currentTarget.value)}
              />
            </Field>

            <Field label="Description" id="bb-description" class="af-form-wide">
              <Textarea
                id="bb-description"
                name="description"
                rows={4}
                placeholder="Context, links, reproduction steps."
              />
            </Field>

            <Field
              label="Acceptance criteria"
              id="bb-ac"
              class="af-form-wide"
              hint="Something verifiable, one per line."
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
            <Button
              class="af-bead-create"
              disabled={
                !offer.enabled ||
                creating ||
                submitting ||
                awaitedCreates.length > 0
              }
              {...(createReason ? { title: createReason } : {})}
              onClick={() => void onCreate()}
            >
              {creating ? "Creating…" : "Create bead"}
            </Button>
            <button
              ref={submitRef}
              type="submit"
              class="af-btn af-btn-primary"
              disabled={submitting || creating}
            >
              {submitting ? "Building…" : "Build command & copy"}
            </button>
          </div>
          {createReason ? (
            <p id="bb-create-reason" class="af-field-hint af-bead-why">
              Create bead is not offered: {createReason}
            </p>
          ) : null}
          {createResult ? (
            <p
              id="bb-create-result"
              role="status"
              class={`af-review-result af-bead-result${
                createResult.tone === "done" ? "" : " is-error"
              }`}
              data-outcome={createResult.tone}
            >
              {createResult.message}
            </p>
          ) : null}
          {!creating && awaitedCreates.length > 0 ? (
            <p class="af-muted af-bead-out">
              A create sent from this page is still out: Create bead is not
              offered until it is answered.
            </p>
          ) : null}
          <NoticePointer sent={sentKeys} />
        </form>
      </Card>

      {latest ? (
        <Card
          id="bead-created-card"
          kicker="created from this page"
          title={latest.created?.title ?? latest.id}
          headingLevel={2}
        >
          <dl class="af-detail-facts">
            <div class="af-detail-row">
              <dt>ID</dt>
              <dd>
                <CopyIdButton issueId={latest.id} />
              </dd>
            </div>
            <div class="af-detail-row">
              <dt>Status</dt>
              <dd>
                <Tag tone={statusTone(latest.status ?? "open")}>
                  {statusLabel(latest.status ?? "open")}
                </Tag>
              </dd>
            </div>
            {latest.assignee ? (
              <div class="af-detail-row">
                <dt>Assignee (claimed)</dt>
                <dd>{latest.assignee}</dd>
              </div>
            ) : null}
            {latest.created ? (
              <div class="af-detail-row">
                <dt>Sent as</dt>
                <dd>
                  {latest.created.type} · {latest.created.priority}
                  {latest.created.parent ? (
                    <>
                      {" "}
                      under <code>{latest.created.parent}</code>
                    </>
                  ) : null}
                </dd>
              </div>
            ) : null}
            {latest.labels && latest.labels.length > 0 ? (
              <div class="af-detail-row">
                <dt>Labels</dt>
                <dd>
                  <span class="af-detail-tags">
                    {latest.labels.map((label) => (
                      <Tag key={label} tone="muted">
                        {label}
                      </Tag>
                    ))}
                  </span>
                </dd>
              </div>
            ) : null}
          </dl>
          <p class="af-muted af-prose">
            The id, status, assignee and labels are what <code>bd</code>{" "}
            answered when each action was taken here; the title, type, priority
            and parent are what this page sent. This page is given no view of
            the tracker, so nothing above is checked against it afterwards, and
            the issue lists show the new bead only once their snapshot is
            rebuilt from the tracker.
          </p>
          {latest.comments.length > 0 ? (
            <ul class="af-detail-comments">
              {latest.comments.map((comment) => (
                <li key={comment.id}>
                  <p class="af-detail-comment-meta">
                    {comment.author} · {comment.createdAt}
                  </p>
                  <p class="af-detail-comment-body">{comment.text}</p>
                </li>
              ))}
            </ul>
          ) : null}
          {/* Keyed: a comment typed for one bead is not left in the field of the next. */}
          <BeadActions
            key={latest.id}
            id={latest.id}
            status={latest.status ?? "open"}
          />
          {made.length > 1 ? (
            <p class="af-muted af-bead-earlier">
              Created earlier from this page:{" "}
              {made.slice(1).map((bead) => (
                <CopyIdButton key={bead.id} issueId={bead.id} />
              ))}
            </p>
          ) : null}
        </Card>
      ) : null}

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
