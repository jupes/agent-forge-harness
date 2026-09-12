import type { JSX } from "preact";
import { useMemo } from "preact/hooks";
import type { BeadsIssue } from "../../../types/beads";
import { Select } from "../ds/Field";
import { listEpics } from "../issues-selection.mjs";

export interface InitiativeSelectProps {
  issues: BeadsIssue[];
  initiativeFilter: string;
  onInitiativeChange: (value: string) => void;
  /** Distinct id per mount — two views can be on screen at once. */
  id?: string;
}

/**
 * Filter by epic. Shared by Dashboard, All issues, Epics and Insights so the
 * four stay in step; the filter value itself lives in the app root.
 */
export function InitiativeSelect({
  issues,
  initiativeFilter,
  onInitiativeChange,
  id = "filter-initiative",
}: InitiativeSelectProps): JSX.Element {
  const epics = useMemo(() => listEpics(issues), [issues]);

  return (
    <div class="af-initiative">
      <label for={id} class="af-initiative-label">
        Initiative
      </label>
      <Select
        id={id}
        value={initiativeFilter}
        onChange={(event) =>
          onInitiativeChange((event.currentTarget as HTMLSelectElement).value)
        }
      >
        <option value="all">All initiatives</option>
        {epics.map((epic: BeadsIssue) => (
          <option key={epic.id} value={epic.id}>
            {epic.title ? `${epic.title}  (${epic.id})` : epic.id}
          </option>
        ))}
      </Select>
    </div>
  );
}
