import type { JSX } from "preact";
import { EmptyState } from "../ds/EmptyState";

/** Placeholder until the forge-run API and view land (checkpoints 25–26). */
export function ForgeRunIsland(): JSX.Element {
  return (
    <EmptyState
      title="Forge run view is not wired up yet"
      hint="This route is built in a later checkpoint of the design-system migration."
    />
  );
}
