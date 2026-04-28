import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { diffPlanLines, type PlanDiffRow } from "../plan-diff";

const CATALOG_URL = "/__agent-forge/plans-api/catalog";
const STORAGE_AUTO_FOLLOW = "agent-forge-plan-review:autoFollow";

type CatalogPayload = {
  draftIds: string[];
  committedIds: string[];
  planIds: string[];
  activePlanId: string | null;
};

type CatalogEnvelope =
  | { ok: true; data: CatalogPayload; error: null }
  | { ok: false; data: null; error: string };

type GitPlanVersion = { sha: string; committedAt: string; subject: string };

type GitHistoryEnvelope = {
  ok: true;
  data: {
    bucket: "drafts" | "committed";
    gitAvailable: boolean;
    versions: GitPlanVersion[];
  };
  error: null;
};

function loadAutoFollowPreference(): boolean {
  try {
    const r = localStorage.getItem(STORAGE_AUTO_FOLLOW);
    if (r === "0") return false;
    if (r === "1") return true;
  } catch {
    /* ignore */
  }
  return true;
}

function saveAutoFollowPreference(v: boolean): void {
  try {
    localStorage.setItem(STORAGE_AUTO_FOLLOW, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function shortSha(sha: string): string {
  return sha.length > 8 ? sha.slice(0, 7) : sha;
}

async function fetchCatalog(): Promise<{ catalog: CatalogPayload | null; apiReachable: boolean; error: string | null }> {
  try {
    const res = await fetch(CATALOG_URL);
    if (!res.ok) {
      return {
        catalog: null,
        apiReachable: false,
        error: `Plans API returned HTTP ${String(res.status)}`,
      };
    }
    const body = (await res.json()) as CatalogEnvelope;
    if (!body.ok || !body.data) {
      return {
        catalog: null,
        apiReachable: true,
        error: body.error ?? "Catalog parse failed",
      };
    }
    return { catalog: body.data, apiReachable: true, error: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      catalog: null,
      apiReachable: false,
      error: msg,
    };
  }
}

async function fetchRaw(bucket: "drafts" | "committed", planId: string): Promise<{ ok: boolean; text: string }> {
  try {
    const q = new URLSearchParams({ bucket, id: planId });
    const res = await fetch(`/__agent-forge/plans-api/raw?${q.toString()}`);
    if (res.status === 404) return { ok: false, text: "" };
    if (!res.ok) return { ok: false, text: "" };
    const text = await res.text();
    return { ok: true, text };
  } catch {
    return { ok: false, text: "" };
  }
}

async function fetchGitHistory(
  planId: string,
  bucket: "drafts" | "committed",
): Promise<{ versions: GitPlanVersion[]; gitAvailable: boolean; error: string | null }> {
  try {
    const q = new URLSearchParams({ id: planId, bucket });
    const res = await fetch(`/__agent-forge/plans-api/git-history?${q.toString()}`);
    const body = (await res.json()) as GitHistoryEnvelope | { ok: false; error: string };
    if (!("ok" in body) || !body.ok || !("data" in body) || !body.data) {
      return {
        versions: [],
        gitAvailable: false,
        error: "ok" in body && "error" in body && typeof body.error === "string" ? body.error : "history request failed",
      };
    }
    return {
      versions: body.data.versions,
      gitAvailable: body.data.gitAvailable,
      error: null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { versions: [], gitAvailable: false, error: msg };
  }
}

/** `ref` is a full git object name, or `WORKING` (must match Vite `git-content` for the working tree). */
async function fetchPlanRef(
  bucket: "drafts" | "committed",
  planId: string,
  ref: string,
): Promise<{ ok: boolean; text: string; error?: string }> {
  if (ref === "WORKING") {
    return fetchRaw(bucket, planId);
  }
  try {
    const q = new URLSearchParams({ bucket, id: planId, ref });
    const res = await fetch(`/__agent-forge/plans-api/git-content?${q.toString()}`);
    const ct = res.headers.get("content-type") ?? "";
    if (res.ok && ct.includes("text/plain")) {
      const text = await res.text();
      return { ok: true, text };
    }
    try {
      const j = (await res.json()) as { ok?: boolean; error?: string };
      return { ok: false, text: "", error: typeof j.error === "string" ? j.error : `HTTP ${String(res.status)}` };
    } catch {
      return { ok: false, text: "", error: `HTTP ${String(res.status)}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: "", error: msg };
  }
}

export function PlanReviewIsland() {
  const [autoFollow, setAutoFollow] = useState<boolean>(() => loadAutoFollowPreference());
  const [catalog, setCatalog] = useState<CatalogPayload | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<string>("");
  const [apiReachable, setApiReachable] = useState<boolean>(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [draftText, setDraftText] = useState<string>("");
  const [committedText, setCommittedText] = useState<string>("");
  const [view, setView] = useState<"draft" | "diff" | "history">("draft");
  const userLockedPlanRef = useRef(false);

  const [historyBucket, setHistoryBucket] = useState<"drafts" | "committed">("drafts");
  const [gitVersions, setGitVersions] = useState<GitPlanVersion[]>([]);
  const [gitAvailable, setGitAvailable] = useState<boolean>(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [olderRef, setOlderRef] = useState<string>("");
  const [newerRef, setNewerRef] = useState<string>("WORKING");
  const [historyOlderText, setHistoryOlderText] = useState<string>("");
  const [historyNewerText, setHistoryNewerText] = useState<string>("");
  const [historyLoadNote, setHistoryLoadNote] = useState<string | null>(null);

  useEffect(() => {
    saveAutoFollowPreference(autoFollow);
  }, [autoFollow]);

  useEffect(() => {
    let cancelled = false;

    const poll = async (): Promise<void> => {
      const r = await fetchCatalog();
      if (cancelled) return;
      setApiReachable(r.apiReachable);
      setCatalogError(r.error);
      if (!r.catalog) {
        setCatalog(null);
        return;
      }
      setCatalog(r.catalog);

      setSelectedPlanId((prev) => {
        const ids = r.catalog?.planIds ?? [];
        if (ids.length === 0) return "";

        if (autoFollow && !userLockedPlanRef.current && r.catalog?.activePlanId) {
          const ap = r.catalog.activePlanId;
          if (ids.includes(ap)) return ap;
        }

        if (!prev || !ids.includes(prev)) {
          const ap = r.catalog?.activePlanId;
          if (ap && ids.includes(ap)) return ap;
          return ids[0] ?? "";
        }
        return prev;
      });
    };

    void poll();
    const id = window.setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [autoFollow]);

  useEffect(() => {
    if (!selectedPlanId || !apiReachable || !catalog?.planIds.includes(selectedPlanId)) {
      setDraftText("");
      setCommittedText("");
      return;
    }

    let cancelled = false;

    const refreshFiles = async (): Promise<void> => {
      const [d, c] = await Promise.all([
        fetchRaw("drafts", selectedPlanId),
        fetchRaw("committed", selectedPlanId),
      ]);
      if (cancelled) return;
      setDraftText(d.ok ? d.text : "");
      setCommittedText(c.ok ? c.text : "");
    };

    void refreshFiles();
    const id = window.setInterval(() => void refreshFiles(), 1600);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [selectedPlanId, apiReachable, catalog]);

  useEffect(() => {
    if (!selectedPlanId || !apiReachable || view !== "history") {
      return;
    }

    let cancelled = false;

    const load = async (): Promise<void> => {
      const r = await fetchGitHistory(selectedPlanId, historyBucket);
      if (cancelled) return;
      setHistoryError(r.error);
      setGitAvailable(r.gitAvailable);
      setGitVersions(r.versions);

      if (r.versions.length >= 2) {
        const v1 = r.versions[1];
        if (v1) setOlderRef(v1.sha);
        setNewerRef("WORKING");
      } else if (r.versions.length === 1) {
        const v0 = r.versions[0];
        if (v0) setOlderRef(v0.sha);
        setNewerRef("WORKING");
      } else {
        setOlderRef("");
        setNewerRef("WORKING");
      }
    };

    void load();
    const id = window.setInterval(() => void load(), 10000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [selectedPlanId, apiReachable, view, historyBucket]);

  useEffect(() => {
    if (!selectedPlanId || !apiReachable || view !== "history") {
      setHistoryOlderText("");
      setHistoryNewerText("");
      setHistoryLoadNote(null);
      return;
    }

    let cancelled = false;

    const loadBoth = async (): Promise<void> => {
      if (!olderRef || !newerRef) {
        setHistoryOlderText("");
        setHistoryNewerText("");
        setHistoryLoadNote(null);
        return;
      }

      const [a, b] = await Promise.all([
        fetchPlanRef(historyBucket, selectedPlanId, olderRef),
        fetchPlanRef(historyBucket, selectedPlanId, newerRef),
      ]);
      if (cancelled) return;

      const notes: string[] = [];
      if (!a.ok) notes.push(`Older snapshot: ${a.error ?? "missing"}`);
      if (!b.ok) notes.push(`Newer snapshot: ${b.error ?? "missing"}`);
      setHistoryLoadNote(notes.length ? notes.join(" ") : null);
      setHistoryOlderText(a.ok ? a.text : "");
      setHistoryNewerText(b.ok ? b.text : "");
    };

    void loadBoth();
    const id = window.setInterval(() => void loadBoth(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [selectedPlanId, apiReachable, view, historyBucket, olderRef, newerRef]);

  const baselineDiffRows = useMemo(() => diffPlanLines(committedText, draftText), [committedText, draftText]);

  const historyDiffRows = useMemo(
    () => diffPlanLines(historyOlderText, historyNewerText),
    [historyOlderText, historyNewerText],
  );

  const activeHint = catalog?.activePlanId ?? null;

  const onPickPlan = (nextId: string): void => {
    userLockedPlanRef.current = true;
    setAutoFollow(false);
    setSelectedPlanId(nextId);
  };

  const onResumeFollow = (): void => {
    userLockedPlanRef.current = false;
    setAutoFollow(true);
    if (catalog?.activePlanId && catalog.planIds.includes(catalog.activePlanId)) {
      setSelectedPlanId(catalog.activePlanId);
    }
  };

  const versionSelectOptions = (): { value: string; label: string }[] => {
    const opts: { value: string; label: string }[] = [
      { value: "WORKING", label: "Working tree (disk)" },
      ...gitVersions.map((v) => ({
        value: v.sha,
        label: `${shortSha(v.sha)} · ${v.committedAt.slice(0, 16)} · ${v.subject.slice(0, 72)}${v.subject.length > 72 ? "…" : ""}`,
      })),
    ];
    return opts;
  };

  if (!apiReachable) {
    return (
      <div className="plan-review-empty">
        <p className="plan-review-banner">
          Plan review needs the dev dashboard API (routes under <code>/__agent-forge/plans-api/</code>). Run{" "}
          <code>bun run dashboard</code> from the harness repo root and open this page from that server — static GitHub Pages
          snapshots cannot reach local plan files.
        </p>
      </div>
    );
  }

  return (
    <div className="plan-review-root-inner">
      {catalogError ? (
        <p className="plan-review-banner plan-review-banner-soft" role="status">
          Catalog warning: {catalogError}
        </p>
      ) : null}

      <div className="plan-review-toolbar">
        <label className="plan-review-field">
          <span className="plan-review-label">Plan</span>
          <select
            className="plan-review-select"
            value={selectedPlanId}
            onChange={(e) => onPickPlan((e.target as HTMLSelectElement).value)}
            aria-label="Select plan id"
          >
            {(catalog?.planIds ?? []).length === 0 ? (
              <option value="">— No plans found —</option>
            ) : (
              (catalog?.planIds ?? []).map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))
            )}
          </select>
        </label>

        <label className="plan-review-follow">
          <input
            type="checkbox"
            checked={autoFollow}
            onChange={(e) => {
              const v = (e.target as HTMLInputElement).checked;
              setAutoFollow(v);
              if (v) {
                userLockedPlanRef.current = false;
                if (catalog?.activePlanId && catalog.planIds.includes(catalog.activePlanId)) {
                  setSelectedPlanId(catalog.activePlanId);
                }
              }
            }}
          />
          <span>Follow session context</span>
        </label>

        {!autoFollow ? (
          <button type="button" className="plan-review-btn plan-review-btn-secondary" onClick={onResumeFollow}>
            Snap to active session plan
          </button>
        ) : null}

        <div className="plan-review-tabs" role="tablist" aria-label="Plan view mode">
          <button
            type="button"
            role="tab"
            aria-selected={view === "draft"}
            className={view === "draft" ? "plan-review-tab plan-review-tab-active" : "plan-review-tab"}
            onClick={() => setView("draft")}
          >
            Draft
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "diff"}
            className={view === "diff" ? "plan-review-tab plan-review-tab-active" : "plan-review-tab"}
            onClick={() => setView("diff")}
          >
            Diff vs committed
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "history"}
            className={view === "history" ? "plan-review-tab plan-review-tab-active" : "plan-review-tab"}
            onClick={() => setView("history")}
          >
            History (git)
          </button>
        </div>

        <p className="plan-review-meta">
          Session active plan id (from <code>plans/session-context.json</code>):{" "}
          <strong>{activeHint ?? "—"}</strong>
        </p>
      </div>

      {(catalog?.planIds ?? []).length === 0 ? (
        <p className="plan-review-empty-msg">
          No markdown plans yet. Add files under <code>plans/drafts/</code> (and optional baselines under{" "}
          <code>plans/committed/</code>). Use <code>plans/session-context.json</code> for auto-follow (see{" "}
          <code>plans/README.md</code>).
        </p>
      ) : view === "draft" ? (
        <pre className="plan-review-pre">
          <code>{draftText || "(empty draft)"}</code>
        </pre>
      ) : view === "diff" ? (
        <div className="plan-review-diff-wrap">
          {!committedText.trim() && !draftText.trim() ? (
            <p className="plan-review-empty-msg">Nothing loaded for this plan id.</p>
          ) : !committedText.trim() ? (
            <p className="plan-review-empty-msg">
              No committed baseline at <code>plans/committed/{selectedPlanId}.md</code>. Commit a snapshot there to enable
              diff.
            </p>
          ) : (
            <pre className="plan-review-diff-pre">
              {baselineDiffRows.map((row: PlanDiffRow, idx: number) => {
                const cls =
                  row.kind === "add"
                    ? "plan-diff-add"
                    : row.kind === "del"
                      ? "plan-diff-del"
                      : "plan-diff-same";
                const prefix = row.kind === "add" ? "+ " : row.kind === "del" ? "- " : "  ";
                return (
                  <span key={idx} className={`plan-diff-line ${cls}`}>
                    {prefix}
                    {row.line}
                    {"\n"}
                  </span>
                );
              })}
            </pre>
          )}
        </div>
      ) : (
        <div className="plan-review-history-panel">
          <div className="plan-review-history-controls">
            <label className="plan-review-field">
              <span className="plan-review-label">History file</span>
              <select
                className="plan-review-select"
                value={historyBucket}
                onChange={(e) => setHistoryBucket((e.target as HTMLSelectElement).value as "drafts" | "committed")}
              >
                <option value="drafts">plans/drafts/{selectedPlanId}.md</option>
                <option value="committed">plans/committed/{selectedPlanId}.md</option>
              </select>
            </label>

            <label className="plan-review-field">
              <span className="plan-review-label">From (older)</span>
              <select
                className="plan-review-select plan-review-select-wide"
                value={olderRef}
                onChange={(e) => setOlderRef((e.target as HTMLSelectElement).value)}
              >
                <option value="">— Select revision —</option>
                {versionSelectOptions().map((o) => (
                  <option key={`o-${o.value}`} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="plan-review-field">
              <span className="plan-review-label">To (newer)</span>
              <select
                className="plan-review-select plan-review-select-wide"
                value={newerRef}
                onChange={(e) => setNewerRef((e.target as HTMLSelectElement).value)}
              >
                {versionSelectOptions().map((o) => (
                  <option key={`n-${o.value}`} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {!gitAvailable ? (
            <p className="plan-review-banner plan-review-banner-soft">
              Git history is unavailable (open the dashboard from a git checkout of the harness repo with <code>git</code> on{" "}
              PATH).
            </p>
          ) : null}

          {historyError ? (
            <p className="plan-review-banner plan-review-banner-soft" role="status">
              History request: {historyError}
            </p>
          ) : null}

          {gitAvailable && gitVersions.length === 0 ? (
            <p className="plan-review-empty-msg">
              No commits found for this path yet. After you commit <code>plans/{historyBucket}/{selectedPlanId}.md</code>,
              revisions appear here for comparison.
            </p>
          ) : null}

          {gitAvailable && gitVersions.length > 0 ? (
            <div className="plan-review-history-table-wrap">
              <table className="plan-review-history-table">
                <thead>
                  <tr>
                    <th>Commit</th>
                    <th>Date</th>
                    <th>Subject</th>
                  </tr>
                </thead>
                <tbody>
                  {gitVersions.map((v) => (
                    <tr key={v.sha}>
                      <td>
                        <code>{shortSha(v.sha)}</code>
                      </td>
                      <td>{v.committedAt.slice(0, 19)}</td>
                      <td>{v.subject}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {historyLoadNote ? (
            <p className="plan-review-banner plan-review-banner-soft" role="status">
              {historyLoadNote}
            </p>
          ) : null}

          {!olderRef ? (
            <p className="plan-review-empty-msg">Select an older revision (or wait for git history to load).</p>
          ) : olderRef === newerRef ? (
            <p className="plan-review-empty-msg">Choose two different revisions to see a diff.</p>
          ) : (
            <pre className="plan-review-diff-pre">
              {historyDiffRows.map((row: PlanDiffRow, idx: number) => {
                const cls =
                  row.kind === "add"
                    ? "plan-diff-add"
                    : row.kind === "del"
                      ? "plan-diff-del"
                      : "plan-diff-same";
                const prefix = row.kind === "add" ? "+ " : row.kind === "del" ? "- " : "  ";
                return (
                  <span key={idx} className={`plan-diff-line ${cls}`}>
                    {prefix}
                    {row.line}
                    {"\n"}
                  </span>
                );
              })}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
