import { render } from "preact";
import { CouncilIsland } from "./islands/CouncilIsland";

const root = document.getElementById("council-root");
if (root) render(<CouncilIsland />, root);
