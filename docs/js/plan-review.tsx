import { render } from "preact";
import { PlanReviewIsland } from "./islands/PlanReviewIsland";
import { StandalonePage } from "./StandalonePage";

function PlanReviewPage() {
  return (
    <StandalonePage
      active="plan-review"
      title="Plan review"
      blurb="Live draft, diff against plans/committed, and git history for each plan file. Needs bun run dashboard at the harness root and a git checkout."
    >
      <PlanReviewIsland />
    </StandalonePage>
  );
}

const root = document.getElementById("app");
if (root) render(<PlanReviewPage />, root);
