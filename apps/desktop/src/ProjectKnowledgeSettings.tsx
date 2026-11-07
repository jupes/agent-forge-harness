import { useEffect } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import type { ProjectRecord } from "../../../types/projects";
import type { useProjectKnowledge } from "./use-project-knowledge";

export function ProjectKnowledgeSettings({
  id,
  project,
  revision,
  writesAllowed,
  knowledge,
}: {
  id: string;
  project: ProjectRecord | null;
  revision: number | null;
  writesAllowed: boolean;
  knowledge: ReturnType<typeof useProjectKnowledge>;
}) {
  const status = knowledge.statuses[id],
    pending = knowledge.pending[id],
    saved = knowledge.receipts[id];
  const receipt =
    saved &&
    (!pending ||
      (saved.requestId === pending.requestId &&
        saved.requestHash === pending.requestHash))
      ? saved
      : null;
  const busy = knowledge.busy !== null,
    writable = writesAllowed && !busy && !knowledge.storageError;
  useEffect(() => {
    void knowledge.owner.inspect(id);
  }, [id, revision]);
  return (
    <section
      class="af-project-keeper"
      aria-labelledby="project-knowledge-heading"
    >
      <h3 id="project-knowledge-heading">Repository knowledge</h3>
      <p>
        Refresh the served repository's knowledge from bounded, redacted tracked
        source using the configured Claude Keeper Smith. Generation has no
        command, file or network tools. Other repository paths do not grant
        source access.
      </p>
      <p>
        Refresh regenerates the complete knowledge document and retains
        supported legacy extensions as unverified. Coverage is limited to 32
        tracked files and 192 KiB of source; unsupported details stay unknown.
        The installed CLI must support the restricted profile.
      </p>
      <p>
        Knowledge is current through day 14, aging through day 30, and stale
        from day 31.
      </p>
      {knowledge.storageError && (
        <p role="alert">
          Recovery metadata is unavailable. Restore browser storage before
          refreshing or publishing; source inspection remains available.
        </p>
      )}
      {knowledge.messages[id] && (
        <p role="status" aria-live="polite">
          {knowledge.messages[id]}
        </p>
      )}
      {knowledge.loading[id] && (
        <p role="status">Checking knowledge freshness…</p>
      )}
      {status ? (
        <p>
          Source: served repository {status.name} · catalog revision{" "}
          {status.catalogRevision} · checked{" "}
          {new Date(status.asOf).toLocaleString()}.{" "}
          {status.state === "missing"
            ? "Knowledge file is missing."
            : `${status.freshness} · ${status.ageDays ?? "unknown"} days old.`}
        </p>
      ) : (
        <p>Knowledge freshness has not been verified.</p>
      )}
      <Button
        disabled={Boolean(knowledge.loading[id])}
        onClick={() => void knowledge.owner.inspect(id)}
      >
        Check knowledge freshness
      </Button>
      <Button
        disabled={
          !writable ||
          !project ||
          project.archived ||
          !status ||
          status.archived ||
          Boolean(pending)
        }
        onClick={() => void knowledge.owner.refresh(id)}
      >
        Refresh knowledge
      </Button>
      {project?.budgets?.dailyApiKeyCapUsd != null && (
        <p>
          Daily API-key protection cannot verify Claude CLI accounting. New
          knowledge generation will be refused while that limit is enabled.
        </p>
      )}
      {pending && (
        <div>
          <p>
            Retained refresh original: <code>{pending.requestId}</code>.
            Generation will not be repeated automatically.
          </p>
          <Button
            disabled={busy || knowledge.storageError}
            onClick={() => void knowledge.owner.checkOriginal(id)}
          >
            Check original knowledge refresh
          </Button>
          {receipt?.candidateHash &&
            ["candidate-saved", "unknown", "publishing"].includes(
              receipt.state,
            ) && (
              <Button
                disabled={!writable}
                onClick={() => void knowledge.owner.recover(id, "publish")}
              >
                Check or publish saved candidate
              </Button>
            )}
          {receipt?.state === "candidate-saved" && (
            <Button
              disabled={!writable}
              onClick={() => void knowledge.owner.recover(id, "retire")}
            >
              Retire never-published candidate
            </Button>
          )}
        </div>
      )}
      {receipt && (
        <div>
          <p>
            Saved original state: {receipt.state}. {receipt.message}
          </p>
          {receipt.confirmedAt && (
            <p>
              Exact candidate confirmed{" "}
              {new Date(receipt.confirmedAt).toLocaleString()}. File age comes
              from the freshness read.
            </p>
          )}
          {receipt.retainedExtensions.length > 0 && (
            <details>
              <summary>
                Retained unverified legacy fields (
                {receipt.retainedExtensions.length})
              </summary>
              <ul>
                {receipt.retainedExtensions.map((field) => (
                  <li key={field}>
                    <code>{field}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
