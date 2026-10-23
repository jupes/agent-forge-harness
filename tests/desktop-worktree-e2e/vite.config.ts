import "./environment";
import {
  HEARTH_PLUGIN_NAME,
  hearthPlugin,
} from "../../scripts/hearth/vite-plugin";
import base from "../../vite.dashboard.config";
import { REPOSITORY } from "./environment";

/** Serve renderer code from the checkout while every operator route serves the fresh repository. */
export default {
  ...base,
  plugins: base.plugins?.map((plugin) =>
    plugin &&
    typeof plugin === "object" &&
    "name" in plugin &&
    plugin.name === HEARTH_PLUGIN_NAME
      ? hearthPlugin(REPOSITORY)
      : plugin,
  ),
};
