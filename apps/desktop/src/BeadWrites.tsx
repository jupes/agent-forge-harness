import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import type { ProjectBeadsPage } from "../../../types/project-beads";
import type { BeadWriteScope } from "./bead-writes-client";
import { desktopHref } from "./navigation";
import { beadHref } from "./ProjectBeads";
import type { DesktopBeadWrites } from "./use-bead-writes";

export function BeadWriteNotices({
  writes,
  scope,
  inbox = false,
}: {
  writes: DesktopBeadWrites;
  scope?: BeadWriteScope;
  inbox?: boolean;
}) {
  const notices = scope
    ? [writes.client.latest(scope)].filter((n) => n !== null)
    : writes.client.notices();
  return (
    <section
      class="af-bead-write-notices"
      aria-label={inbox ? "Bead write outcomes" : "Current bead write"}
    >
      {inbox && (
        <>
          <h1>Inbox</h1>
          <p>
            Bead writes needing attention in this window. Other Inbox sources
            are not available yet.
          </p>
        </>
      )}
      {writes.client.problem() && <p role="alert">{writes.client.problem()}</p>}
      {notices.map((n) => (
        <article class="af-notice" key={n.key}>
          <p role="status">
            <strong>
              {n.phase === "sending"
                ? "Sending"
                : n.phase === "unknown"
                  ? "Outcome unknown"
                  : n.phase === "refused"
                    ? "Refused"
                    : "Done"}
            </strong>{" "}
            · {n.message}
          </p>
          {n.title && <p>{n.title}</p>}
          <Button
            href={
              (n.createdId ?? n.beadId)
                ? beadHref(n.projectId, n.createdId ?? n.beadId ?? "", true)
                : desktopHref({
                    projectId: n.projectId,
                    destination: "beads",
                    selection: null,
                  })
            }
          >
            {(n.createdId ?? n.beadId)
              ? `Check ${n.createdId ?? n.beadId}`
              : "Check project beads"}
          </Button>
          {n.phase !== "sending" && (
            <Button
              onClick={() => {
                writes.client.checked(n.key);
              }}
            >
              I checked this write · dismiss
            </Button>
          )}
        </article>
      ))}
      {inbox && !notices.length && (
        <p>No retained bead writes need checking.</p>
      )}
    </section>
  );
}

export function NewBeadForm({
  writes,
  page,
  onCancel,
  initial = "open",
}: {
  writes: DesktopBeadWrites;
  page: ProjectBeadsPage;
  onCancel(): void;
  initial?: "open" | "proposed";
}) {
  const options = writes.options;
  const [title, setTitle] = useState("");
  const [type, setType] = useState("task");
  const [priority, setPriority] = useState<string>(
    options?.defaultPriority ?? "P2",
  );
  const [parent, setParent] = useState("");
  const [description, setDescription] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [labels, setLabels] = useState("");
  const [complexity, setComplexity] = useState("");
  const [fileMap, setFileMap] = useState("");
  const [state, setState] = useState(initial);
  const [submitted, setSubmitted] = useState(false);
  const titleInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => titleInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [options]);
  const scope = { projectId: page.projectId, workspace: page.workspace };
  const held = writes.client.held(scope) || !writes.writesAllowed;
  const epics = page.beads.filter(
    (bead) => bead.type === "epic" && bead.status !== "closed",
  );
  if (!options)
    return (
      <>
        <p role="status">{writes.error ?? "Loading bead options…"}</p>
        <Button onClick={writes.refresh} disabled={writes.loading}>
          Refresh bead options
        </Button>
      </>
    );
  const lines = (text: string) =>
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  const labelValues = [
    ...new Set(
      labels
        .split(/[,\n]/)
        .map((label) => label.trim())
        .filter(Boolean),
    ),
  ];
  const mapValues = lines(fileMap);
  const valid =
    title.trim().length > 0 &&
    !!parent &&
    labelValues.length < options.limits.labels &&
    mapValues.length <= options.limits.fileMap;
  return (
    <form
      class="af-bead-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid || submitted || held) return;
        setSubmitted(true);
        void writes.client
          .create(
            scope,
            {
              title: title.trim(),
              type,
              priority,
              parent,
              description,
              acceptance: lines(acceptance)
                .map((line) =>
                  /^[-*] \[[ xX]\]/.test(line) ? line : `- [ ] ${line}`,
                )
                .join("\n"),
              labels: labelValues,
              ...(complexity ? { complexity } : {}),
              ...(mapValues.length ? { fileMap: mapValues } : {}),
            },
            state,
          )
          .then((outcome) => {
            if (!outcome || (outcome.phase === "refused" && !outcome.createdId))
              setSubmitted(false);
          });
      }}
    >
      <p>
        Describe one useful change. The hearth adds this project's membership
        label.
      </p>
      <fieldset disabled={held || submitted}>
        <label>
          Title
          <input
            ref={titleInput}
            required
            maxLength={options.limits.title}
            value={title}
            onInput={(e) => setTitle(e.currentTarget.value)}
            placeholder="Add a useful capability"
          />
        </label>
        <small>Start with a verb: add, fix, verify or document.</small>
        <div class="af-bead-form-pair">
          <label>
            Type
            <select
              value={type}
              onChange={(e) => setType(e.currentTarget.value)}
            >
              {options.types.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select
              value={priority}
              onChange={(e) => setPriority(e.currentTarget.value)}
            >
              {options.priorities.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.value} · {p.tier}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p>{options.priorities.find((p) => p.value === priority)?.meaning}</p>
        <label>
          Parent epic
          <select
            required
            value={parent}
            onChange={(e) => setParent(e.currentTarget.value)}
          >
            <option value="">Choose a project epic</option>
            {epics.map((e) => (
              <option key={e.id} value={e.id}>
                {e.id} · {e.title}
              </option>
            ))}
          </select>
        </label>
        {!epics.length && (
          <p role="status">
            No open epic is in this project's current scope. Check the project
            scope before creating a bead.
          </p>
        )}
        <label>
          Description
          <textarea
            rows={4}
            maxLength={options.limits.description}
            value={description}
            onInput={(e) => setDescription(e.currentTarget.value)}
          />
        </label>
        <label>
          Acceptance criteria · one per line
          <textarea
            rows={3}
            maxLength={options.limits.acceptance}
            value={acceptance}
            onInput={(e) => setAcceptance(e.currentTarget.value)}
          />
        </label>
        <label>
          Labels · comma separated
          <input
            value={labels}
            onInput={(e) => setLabels(e.currentTarget.value)}
          />
        </label>
        <small>
          Up to {options.limits.labels - 1} labels; {options.limits.label}{" "}
          characters each. Queue and complexity labels are set by their
          controls.
        </small>
        <label>
          Complexity
          <select
            value={complexity}
            onChange={(e) => setComplexity(e.currentTarget.value)}
          >
            <option value="">Unspecified · default bench</option>
            {options.complexities.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          File map · one relative glob per line
          <textarea
            rows={3}
            value={fileMap}
            onInput={(e) => setFileMap(e.currentTarget.value)}
            placeholder="apps/desktop/src/**"
          />
        </label>
        <small>
          The file map becomes a Files section in the description. Avoid
          including a second Files section above.
        </small>
        <label>
          Initial state
          <select
            value={state}
            onChange={(e) =>
              setState(
                e.currentTarget.value === "proposed" ? "proposed" : "open",
              )
            }
          >
            <option value="open">Open</option>
            <option value="proposed">Proposed</option>
          </select>
        </label>
        <p>
          Proposed creates the bead first, then requests its queue transition.
          Neither step approves or starts it.
        </p>
      </fieldset>
      {!valid && (
        <p role="status">
          Enter a title, choose a parent epic and stay within the label and file
          map limits.
        </p>
      )}
      <BeadWriteNotices writes={writes} scope={scope} />
      <div class="af-beads-actions">
        <button
          class="af-btn af-btn-primary"
          type="submit"
          disabled={!valid || held || submitted}
        >
          Create bead
        </button>
        <Button onClick={onCancel}>{submitted ? "Close" : "Cancel"}</Button>
      </div>
    </form>
  );
}

export function BeadWriteActions({
  writes,
  page,
  id,
  disabled,
}: {
  writes: DesktopBeadWrites;
  page: ProjectBeadsPage;
  id: string;
  disabled: boolean;
}) {
  const [editor, setEditor] = useState<"comment" | "close" | null>(null);
  const [text, setText] = useState("");
  const editorInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editor) editorInput.current?.focus();
  }, [editor]);
  const scope = { projectId: page.projectId, workspace: page.workspace };
  const bead = page.beads.find((b) => b.id === id);
  const locked = disabled || writes.client.held(scope) || !writes.options;
  return (
    <div class="af-bead-write-actions">
      {writes.error && (
        <p role="alert">
          {writes.error}{" "}
          <Button onClick={writes.refresh} disabled={writes.loading}>
            Refresh bead options
          </Button>
        </p>
      )}
      <div class="af-beads-actions">
        <Button
          disabled={locked || bead?.status === "closed" || !!bead?.assignee}
          onClick={() => {
            void writes.client.act(scope, "claim", id);
          }}
        >
          Claim
        </Button>
        <Button
          disabled={locked}
          onClick={() => {
            setEditor("comment");
            setText("");
          }}
        >
          Comment
        </Button>
        <Button
          disabled={locked || bead?.status === "closed"}
          onClick={() => {
            setEditor("close");
            setText("");
          }}
        >
          Close bead
        </Button>
        <Button
          disabled={locked || bead?.status === "closed" || bead?.queue !== null}
          onClick={() => {
            void writes.client.act(scope, "propose", id);
          }}
        >
          Propose
        </Button>
      </div>
      {editor && (
        <form
          class="af-bead-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (locked || !text.trim()) return;
            const action = editor;
            setEditor(null);
            void writes.client.act(scope, action, id, text);
          }}
        >
          <label>
            {editor === "close" ? "Evidence for closing" : "Comment text"}
            <textarea
              required
              ref={editorInput}
              rows={3}
              maxLength={
                editor === "close"
                  ? writes.options?.limits.reason
                  : writes.options?.limits.comment
              }
              value={text}
              onInput={(e) => setText(e.currentTarget.value)}
            />
          </label>
          {editor === "close" && (
            <p>
              Record what was verified and the evidence that meets the
              acceptance criteria.
            </p>
          )}
          <div class="af-beads-actions">
            <button
              class="af-btn af-btn-primary"
              type="submit"
              disabled={locked || !text.trim()}
            >
              {editor === "close" ? "Close with evidence" : "Add comment"}
            </button>
            <Button onClick={() => setEditor(null)}>Cancel {editor}</Button>
          </div>
        </form>
      )}
    </div>
  );
}
