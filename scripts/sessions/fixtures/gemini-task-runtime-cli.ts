import { isMain } from "../../is-main";
import { runGeminiTaskRuntimeFixture } from "./gemini-task-runtime-fixture";

if (isMain(import.meta)) await runGeminiTaskRuntimeFixture();
