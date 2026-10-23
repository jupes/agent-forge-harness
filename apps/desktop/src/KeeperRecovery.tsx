import { useEffect, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import type { KeeperReadiness } from "../../../types/keeper-recovery";
import type { KeeperClient } from "./keeper-client";

export function KeeperReadinessLabel({
  readiness,
}: {
  readiness: KeeperReadiness | undefined;
}) {
  const label = !readiness
    ? "Keeper smith not verified"
    : readiness.connection === "signed-out"
      ? "Provider signed out"
      : readiness.connection === "adapter-missing"
        ? "Keeper adapter missing"
        : readiness.allowance === "exhausted"
          ? "Provider allowance exhausted"
          : !readiness.canStart
            ? "Keeper unavailable"
            : readiness.allowance === "unreported"
              ? "Provider reporting unavailable"
              : "Keeper ready";
  return <strong>{label}</strong>;
}

export function KeeperRecovery({
  projectId,
  client,
  open,
  onClose,
  writesAllowed,
}: {
  projectId: string;
  client: KeeperClient;
  open: boolean;
  onClose(): void;
  writesAllowed: boolean;
}) {
  const recovery = client.recovery;
  const view = recovery?.get(projectId),
    page = view?.page;
  const [smith, setSmith] = useState("");
  const [summary, setSummary] = useState("");
  useEffect(() => {
    if (page?.selectedSmith) setSmith(page.selectedSmith);
  }, [page?.selectedSmith]);
  if (!recovery || !view) return null;
  const selected = page?.choices.find(
    (item) => item.smith.name === page.selectedSmith,
  );
  const candidate = page?.choices.find((item) => item.smith.name === smith);
  const unavailable = selected && !selected.readiness.canStart;
  return (
    <aside
      class={`af-keeper-recovery${unavailable ? " is-unavailable" : ""}`}
      aria-label="Keeper smith and retained context"
    >
      <div class="af-keeper-recovery-heading">
        <KeeperReadinessLabel readiness={selected?.readiness} />
        <button
          type="button"
          class="af-btn af-btn-secondary"
          aria-disabled={view.loading}
          onClick={() => {
            if (!view.loading) void recovery.read(projectId);
          }}
        >
          Recheck readiness
        </button>
      </div>
      <p role="status">
        {view.loading && !page
          ? "Checking Keeper readiness…"
          : (selected?.readiness.reason ??
            "The selected smith is missing or its configuration could not be read. Choose an enabled smith after rechecking.")}
      </p>
      {selected && (
        <small>
          {selected.readiness.source} ·{" "}
          <time dateTime={selected.readiness.asOf}>
            {new Date(selected.readiness.asOf).toLocaleString()}
          </time>
        </small>
      )}
      {view.notice && <p role="status">{view.notice}</p>}
      {view.pending && (
        <div class="af-keeper-recovery-actions">
          <button
            type="button"
            class="af-btn af-btn-secondary"
            aria-disabled={view.loading}
            onClick={() => {
              if (!view.loading) void recovery.read(projectId);
            }}
          >
            Check original Keeper change
          </button>
          <Button
            disabled={!writesAllowed || view.posting}
            onClick={() => {
              void recovery.retry(projectId);
            }}
          >
            Retry original Keeper change
          </Button>
        </div>
      )}
      {page?.continuation && (
        <p class="af-keeper-retention">
          {page.continuation.resumed
            ? "Continuing the same provider conversation."
            : "The next conversation receives the reviewed summary; earlier messages remain in saved history."}
        </p>
      )}
      <details
        open={open}
        onToggle={(event) => {
          if (!event.currentTarget.open) onClose();
        }}
      >
        <summary>Change smith or start fresh</summary>
        <p>
          A change starts no model turn. A different provider receives only the
          summary you review here; it cannot resume another provider's session.
          Saved messages stay in this project.
        </p>
        <label>
          Keeper smith
          <select
            aria-label="Keeper smith"
            value={smith}
            onChange={(event) => setSmith(event.currentTarget.value)}
          >
            {page?.choices.map((choice) => (
              <option
                key={choice.smith.name}
                value={choice.smith.name}
                disabled={!choice.smith.enabled || !choice.readiness.canStart}
              >
                {choice.smith.name} · {choice.smith.provider} ·{" "}
                {choice.smith.model}
                {!choice.readiness.canStart ? " · unavailable" : ""}
              </option>
            ))}
          </select>
        </label>
        {candidate && <p>{candidate.readiness.reason}</p>}
        <label>
          Retained summary (review before continuing)
          <textarea
            aria-label="Retained summary (review before continuing)"
            maxLength={12_000}
            rows={4}
            value={summary}
            onInput={(event) => setSummary(event.currentTarget.value)}
            placeholder="Write or review the exact context the new conversation should keep."
          />
        </label>
        {client.get(projectId).briefs?.latest && (
          <Button
            onClick={() =>
              setSummary(
                client.get(projectId).briefs?.latest?.content.summary ?? "",
              )
            }
          >
            Use latest confirmed brief as draft summary
          </Button>
        )}
        <p>
          Start fresh keeps exactly this summary for the next turn. It does not
          automatically summarize the conversation. Review the text before
          confirming.
        </p>
        <div class="af-keeper-recovery-actions">
          <Button
            disabled={
              !writesAllowed ||
              !recovery.canChange(projectId) ||
              !candidate?.readiness.canStart ||
              smith === page?.selectedSmith
            }
            onClick={() => {
              void recovery.change(projectId, {
                mode: "switch",
                smith,
                summary,
              });
            }}
          >
            Use selected smith
          </Button>
          <Button
            disabled={
              !writesAllowed ||
              !recovery.canChange(projectId) ||
              !candidate?.readiness.canStart ||
              !summary.trim()
            }
            onClick={() => {
              void recovery.change(projectId, {
                mode: "fresh",
                smith,
                summary,
              });
            }}
          >
            Start fresh with reviewed summary
          </Button>
        </div>
        {page?.continuation?.summary && (
          <details>
            <summary>Last retained summary</summary>
            <p class="af-keeper-retained-summary">
              {page.continuation.summary}
            </p>
          </details>
        )}
      </details>
    </aside>
  );
}
