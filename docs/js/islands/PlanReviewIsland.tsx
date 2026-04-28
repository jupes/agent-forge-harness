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

export function PlanReviewIsland() {
  const [autoFollow, setAutoFollow] = useState<boolean>(() => loadAutoFollowPreference());
  const [catalog, setCatalog] = useState<CatalogPayload | null>(null);
  const [selectedPlanId, setSelectedPlanId] = useState<string>("");
  const [apiReachable, setApiReachable] = useState<boolean>(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [draftText, setDraftText] = useState<string>("");
  const [committedText, setCommittedText] = useState<string>("");
  const [view, setView] = useState<"draft" | "diff">("draft");
  const userLockedPlanRef = useRef(false);

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

  const diffRows = useMemo(() => diffPlanLines(committedText, draftText), [committedText, draftText]);

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
      ) : (
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
              {diffRows.map((row: PlanDiffRow, idx: number) => {
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
