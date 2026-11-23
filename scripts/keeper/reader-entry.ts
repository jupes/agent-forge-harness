/** Source CLI only; packaged callers import the pure reader runtime. */
import { isMain } from "../is-main";
import { runKeeperReader } from "./reader-runtime";

export { parseKeeperReaderArgs, runKeeperReader } from "./reader-runtime";

if (isMain(import.meta)) runKeeperReader(process.argv.slice(2));
