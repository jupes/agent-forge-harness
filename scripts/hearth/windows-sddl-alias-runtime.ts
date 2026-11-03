import { existsSync } from "node:fs";

export const SDDL_ALIAS_RUNTIME_ENV = "AGENT_FORGE_TEST_SDDL_ALIAS_RUNTIME";
export const PWSH_7_EXECUTABLE = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

export type SddlAliasRuntime = "system32" | "pwsh-7";

const INVALID_RUNTIME_SELECTOR =
  SDDL_ALIAS_RUNTIME_ENV + " must be unset or pwsh-7.";
const MISSING_PWSH_7 =
  "The fixed PowerShell 7 executable for SDDL alias lookup does not exist.";

export function validateSddlAliasRuntime(
  value: string | undefined,
): SddlAliasRuntime {
  if (value === undefined) return "system32";
  if (value === "pwsh-7") return value;
  throw new Error(INVALID_RUNTIME_SELECTOR);
}

export function resolveSddlAliasRuntime(
  value: string | undefined,
  fileExists: (path: string) => boolean = existsSync,
): SddlAliasRuntime {
  const runtime = validateSddlAliasRuntime(value);
  if (runtime !== "pwsh-7") return runtime;
  if (!fileExists(PWSH_7_EXECUTABLE)) throw new Error(MISSING_PWSH_7);
  return runtime;
}
