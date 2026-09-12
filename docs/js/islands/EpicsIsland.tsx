import type { JSX } from "preact";
import type { BeadsIssue, BeadsPayload } from "../../../types/beads";
import { Card } from "../ds/Card";
import { EmptyState } from "../ds/EmptyState";
import { ProgressBar } from "../ds/ProgressBar";
import { Tag } from "../ds/Tag";
import { statusTone } from "../issue-presentation";
import { CopyIdButton } from "./CopyIdButton";
import { InitiativeSelect } from "./InitiativeSelect";

export interface EpicsIslandProps {
  payload: BeadsPayload;
  initiativeFilter: string;
  onInitiativeChange: (value: string) => void;
}

/** Truncation length kept from the legacy view — no ellipsis, as before. */
const DESCRIPTION_LIMIT = 200;

export function EpicsIsland({
  payload,
  initiativeFilter,
  onInitiativeChange,
}: EpicsIslandProps): JSX.Element {
  const issues = payload.issues ?? [];
  // Ordering comes from the payload's own byType emission order, not from
  // listEpics()'s alphabetical sort — the two have always differed, and the
  // Epics page has always used this one.
  const allEpics = payload.derived?.byType?.epic ?? [];
  const epics =
    initiativeFilter === "all"
      ? allEpics
      : allEpics.filter((epic) => epic.id === initiativeFilter);

  return (
    <>
      <InitiativeSelect
        issues={issues}
        initiativeFilter={initiativeFilter}
        onInitiativeChange={onInitiativeChange}
        id="filter-initiative-epics"
      />

      {epics.length === 0 ? (
        <EmptyState
          title="No epics yet"
          hint={
            <>
              Create one: <code>bd create --type epic --title "My Epic"</code>
            </>
          }
        />
      ) : (
        <div class="af-epic-list">
          {epics.map((epic: BeadsIssue) => {
            const children = issues.filter((issue) => issue.parent === epic.id);
            const closed = children.filter(
              (issue) => issue.status === "closed",
            ).length;
            const pct =
              children.length > 0
                ? Math.round((closed / children.length) * 100)
                : 0;

            return (
              <Card key={epic.id} class="af-epic">
                <div class="af-epic-head">
                  <CopyIdButton issueId={epic.id} />
                  <h3 class="af-epic-title">{epic.title}</h3>
                  <Tag tone={statusTone(epic.status)}>{epic.status}</Tag>
                  {epic.due ? (
                    <span class="af-epic-due">
                      Due: {epic.due.slice(0, 10)}
                    </span>
                  ) : null}
                </div>

                <ProgressBar
                  value={closed}
                  max={children.length}
                  label={`${epic.title}: ${closed} of ${children.length} tasks complete`}
                />
                <p class="af-epic-progress">
                  {closed}/{children.length} tasks · {pct}%
                </p>

                {epic.description ? (
                  <p class="af-epic-description">
                    {epic.description.slice(0, DESCRIPTION_LIMIT)}
                  </p>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
