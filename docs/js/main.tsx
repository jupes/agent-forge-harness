import { render } from "preact";
import { DashboardApp } from "./app";

const root = document.getElementById("app");
if (root) render(<DashboardApp />, root);
