/** Source entry only; the compiled entry imports the side-effect-free implementation. */
import { isMain } from "../../is-main";
import { runCodexTaskRuntimeFixture } from "./codex-task-runtime-fixture";

if (isMain(import.meta)) await runCodexTaskRuntimeFixture(import.meta.path);
