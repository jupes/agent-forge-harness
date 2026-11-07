import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../../../docs/js/ds/Button";
import { operatorRead } from "../../../docs/js/operator";
import { pageReads, readOperatorRoute } from "../../../docs/js/use-stream";
import {
  NO_PROJECT_BUDGETS,
  type ProjectBudgetStatus,
  type ProjectBudgets,
  projectBudgetStatusSchema,
} from "../../../scripts/projects/project-budgets-protocol";
import { parseProjectBudgetText } from "./project-budgets-client";
import type { useProjectValueSettings } from "./use-project-value-settings";

export function ProjectBudgetsSettings({
  projectId,
  archived,
  writesAllowed,
  settings,
}: {
  projectId: string;
  archived: boolean;
  writesAllowed: boolean;
  settings: ReturnType<typeof useProjectValueSettings<ProjectBudgets>>;
}) {
  const state = settings.projects[projectId],
    current = state?.draft ?? state?.catalog?.value ?? NO_PROJECT_BUDGETS;
  const editable =
    writesAllowed && !archived && !settings.busy && Boolean(state?.catalog);
  const [raw, setRaw] = useState<{
    projectId: string;
    shiftSpendCapUsd: string;
    dailyApiKeyCapUsd: string;
  } | null>(null);
  const text =
    raw?.projectId === projectId && state?.draft != null
      ? raw
      : {
          projectId,
          shiftSpendCapUsd: String(current.shiftSpendCapUsd ?? ""),
          dailyApiKeyCapUsd: String(current.dailyApiKeyCapUsd ?? ""),
        };
  const parsed = parseProjectBudgetText(text);
  const editText = (
    field: "shiftSpendCapUsd" | "dailyApiKeyCapUsd",
    value: string,
  ) => {
    const next = { ...text, [field]: value };
    setRaw(next);
    const valid = parseProjectBudgetText(next);
    if (valid.success) settings.owner.edit(projectId, valid.data);
    else if (state?.draft === null)
      settings.owner.edit(projectId, { ...current });
  };
  const generation = useRef(0);
  const [status, setStatus] = useState<{
    projectId: string;
    data: ProjectBudgetStatus | null;
    loading: boolean;
    error: string;
  }>({ projectId, data: null, loading: true, error: "" });
  const refresh = async () => {
    const turn = ++generation.current;
    setStatus((prior) => ({
      projectId,
      data: prior.projectId === projectId ? prior.data : null,
      loading: true,
      error: "",
    }));
    try {
      const data = projectBudgetStatusSchema.parse(
        await readOperatorRoute<unknown>(
          `/projects/${encodeURIComponent(projectId)}/settings/budgets`,
          { ...pageReads(), fetch: operatorRead },
        ),
      );
      if (data.projectId !== projectId) throw Error("Budget scope changed");
      if (turn === generation.current)
        setStatus({ projectId, data, loading: false, error: "" });
    } catch {
      if (turn === generation.current)
        setStatus((prior) => ({
          ...prior,
          loading: false,
          error:
            "Costs could not be verified. Retained values are from the last successful check.",
        }));
    }
  };
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [projectId, state?.catalog?.revision]);
  const shown = status.projectId === projectId ? status : null;
  return (
    <section
      class="af-project-keeper"
      aria-labelledby="project-budgets-heading"
    >
      <h3 id="project-budgets-heading">Budgets</h3>
      <p>
        Local project admission limits, in USD. These are not provider account
        balances or guaranteed billing ceilings. An already running attempt may
        report an overage; that overage remains recorded.
      </p>
      <p>
        Source: project catalog · revision{" "}
        {state?.catalog?.revision ?? "unavailable"}. Blank means no project
        limit.
      </p>
      <p>
        Saved Shift cap:{" "}
        {state?.catalog?.value.shiftSpendCapUsd ?? "No project limit"} · Saved
        daily cap:{" "}
        {state?.catalog?.value.dailyApiKeyCapUsd ?? "No project limit"}
      </p>
      {state?.message && (
        <p role="status" aria-live="polite">
          {state.message}
        </p>
      )}
      <Button
        disabled={Boolean(settings.busy)}
        onClick={() => void settings.owner.review(projectId)}
      >
        Check current project budgets
      </Button>
      {state?.needsReview && state.checked && (
        <Button
          disabled={!editable}
          onClick={() => settings.owner.confirmReview(projectId)}
        >
          I reviewed the current project budgets
        </Button>
      )}
      <form
        class="af-project-settings-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (
            editable &&
            state?.draft &&
            !state.needsReview &&
            parsed.success
          ) {
            settings.owner.edit(projectId, parsed.data);
            void settings.owner.save(projectId);
          }
        }}
      >
        <label>
          Shift spend cap (USD)
          <input
            type="text"
            inputMode="decimal"
            maxLength={32}
            value={text.shiftSpendCapUsd}
            disabled={!editable}
            onInput={(event) =>
              editText("shiftSpendCapUsd", event.currentTarget.value)
            }
          />
        </label>
        <p>
          New Shifts must use a reviewed max USD within this cap. Further
          attempts, including repairs, stop being admitted when reported spend
          reaches it or an attempt does not report cost. Running attempts keep
          their original authority.
        </p>
        <label>
          Daily API-key admission cap (USD)
          <input
            type="text"
            inputMode="decimal"
            maxLength={32}
            value={text.dailyApiKeyCapUsd}
            disabled={!editable}
            onInput={(event) =>
              editText("dailyApiKeyCapUsd", event.currentTarget.value)
            }
          />
        </label>
        <p>
          Daily protection supports project Council API reviews using the full
          reviewed max USD allocation. Admission days use UTC. Outstanding or
          unreported charges remain held across midnight and restart; estimates
          do not release them.
        </p>
        <p>
          While daily protection is enabled, new Session, Keeper and Shift
          provider work is refused because those modes cannot verify the
          required API-key authentication and cost accounting. Existing
          execution, Stop and original recovery remain available.
        </p>
        {!parsed.success && (
          <p role="status">
            Enter positive USD amounts up to 1,000,000 with at most six decimal
            places, or leave a field blank for no project limit.
          </p>
        )}
        <button
          type="submit"
          class="af-btn af-btn-primary"
          disabled={
            !editable || !state?.draft || state.needsReview || !parsed.success
          }
        >
          Save project budgets
        </button>
      </form>
      <h4>Last checked admission costs</h4>
      <Button disabled={Boolean(shown?.loading)} onClick={() => void refresh()}>
        Refresh admission costs
      </Button>
      {shown?.loading && <p role="status">Reading local admission costs…</p>}
      {shown?.error && <p role="alert">{shown.error}</p>}
      {shown?.data ? (
        <>
          <p>
            Source: local allocation journal · checked {shown.data.asOf} · UTC
            admission day {shown.data.day}
          </p>
          <dl>
            <dt>Reported actual USD</dt>
            <dd>
              {shown.data.reservedUsd > 0
                ? `— · ${shown.data.reportedUsd} USD reported so far; costs remain outstanding`
                : shown.data.reportedUsd}
            </dd>
            <dt>Estimated USD · not billed spend</dt>
            <dd>{shown.data.estimatedUsd}</dd>
            <dt>Outstanding allocated USD</dt>
            <dd>{shown.data.reservedUsd}</dd>
            <dt>Unreported outcomes</dt>
            <dd>{shown.data.unknownCount}</dd>
          </dl>
        </>
      ) : (
        !shown?.loading && <p>Admission costs: — · unavailable</p>
      )}
    </section>
  );
}
