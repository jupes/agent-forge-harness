import "./environment";
import {
  HEARTH_PLUGIN_NAME,
  hearthPlugin,
} from "../../scripts/hearth/vite-plugin";
import base from "../../vite.dashboard.config";
import { REPOSITORY } from "./environment";
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
