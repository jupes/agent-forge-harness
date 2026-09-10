import type { JSX } from "preact";
import { EmptyState } from "../ds/EmptyState";

/** Placeholder until the repos/knowledge API and view land (checkpoints 27–28). */
export function ReposIsland(): JSX.Element {
  return (
    <EmptyState
      title="Repos & knowledge view is not wired up yet"
      hint="This route is built in a later checkpoint of the design-system migration."
    />
  );
}
