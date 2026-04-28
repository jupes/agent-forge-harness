// Plan review page — Preact island.
import { h } from "preact";
import { mountIsland } from "./preact-bridge.tsx";
import { PlanReviewIsland } from "./islands/PlanReviewIsland.tsx";

const root = document.getElementById("plan-review-root");
if (root) {
  mountIsland(root, h(PlanReviewIsland, {}));
}
