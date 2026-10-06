import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import type { ExecutorAdapter } from "./types";

/** Providers the harness can drive today. Gemini lands with x1gs.4.4. */
export const ADAPTERS: Readonly<Record<string, ExecutorAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};
