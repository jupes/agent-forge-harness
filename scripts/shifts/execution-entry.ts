/** Source-only entry; compiled modes import the pure execution runtime. */
import { isMain } from "../is-main";
import { runProjectShiftExecutionEntry } from "./execution-runtime";

export { runProjectShiftExecutionEntry } from "./execution-runtime";

if (isMain(import.meta))
  await runProjectShiftExecutionEntry(process.argv.slice(2));
