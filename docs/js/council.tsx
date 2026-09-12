import { render } from "preact";
import { CouncilIsland } from "./islands/CouncilIsland";
import { StandalonePage } from "./StandalonePage";

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
