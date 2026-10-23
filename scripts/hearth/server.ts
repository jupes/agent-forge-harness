/** Source hearth entry. Import server-runtime for explicit source/packaged composition. */
import { isMain } from "../is-main";
import { runHearthServer } from "./server-runtime";

export * from "./server-runtime";

if (isMain(import.meta)) {
  void runHearthServer(process.argv.slice(2));
}
