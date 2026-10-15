import type { JSX } from "preact";
import { Button } from "../ds/Button";

/**
 * The Council page with a bead preselected as its source: `CouncilIsland`
 * reads `?sourceType=bead&source=<id>`.
 */
export function councilHref(id: string): string {
  return `council.html?${new URLSearchParams({ sourceType: "bead", source: id })}`;
}

/**
 * Send a bead to council (`x1gs.7.2`): a link to the Council page with the
 * bead preselected. The profile, the budget, the preview of what would be
 * sent, Convene and the run's progress are that page's; the verdict is posted
 * back to the bead by the hearth when the run completes. `inline` draws a text
 * link for a line of metadata (a forge-run checkpoint) instead of a button.
 */
export function SendToCouncil({
  id,
  inline = false,
}: {
  id: string;
  inline?: boolean;
}): JSX.Element {
  const label = `Send ${id} to council`;
  return inline ? (
    <a class="af-timeline-link" href={councilHref(id)} aria-label={label}>
      council
    </a>
  ) : (
    <Button href={councilHref(id)} icon="users-three" aria-label={label}>
      Send to council
    </Button>
  );
}
