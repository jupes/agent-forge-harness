import { render } from "preact";
import { CouncilIsland } from "./islands/CouncilIsland";
import { startPageLaunch } from "./operator";
import { StandalonePage } from "./StandalonePage";

// First, as the dashboard's boot does: a launch link's secret leaves the
// address bar and is exchanged for the page's session (`operator.ts`).
startPageLaunch();

function CouncilPage() {
  return (
    <StandalonePage
      active="council"
      title="Council review"
      blurb="A panel of models reviews independently, challenges anonymously, then a chair synthesizes."
    >
      <CouncilIsland />
    </StandalonePage>
  );
}

const root = document.getElementById("app");
if (root) render(<CouncilPage />, root);
