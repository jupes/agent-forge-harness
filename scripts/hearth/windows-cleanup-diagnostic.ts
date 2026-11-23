import { join } from "node:path";

/** Narrow, opt-in Windows fixture cleanup evidence; never emits file contents. */
export const WINDOWS_CLEANUP_DIAGNOSTIC =
  "AGENT_FORGE_TEST_WINDOWS_CLEANUP_DIAGNOSTIC";
export const WINDOWS_CLEANUP_DIAGNOSTIC_CASE =
  "AGENT_FORGE_TEST_WINDOWS_CLEANUP_DIAGNOSTIC_CASE";
export const GEMINI_PREVIEW_DIAGNOSTIC_CASE =
  "protected Gemini preview audits before actual read-only native probes and reserves no session";

export type WindowsCleanupEvidence = Readonly<{
  case: string;
  operation: "before-remove-fixture-root" | "remove-fixture-root-failed";
  target: string;
  errorCode: string | null;
  liveChildCount: number;
  resources: readonly string[];
  rootEntries: readonly string[];
  rootEntriesTruncated: boolean;
  lockerPids: readonly number[] | null;
  lockerProbe: "ok" | "unavailable";
}>;

export function windowsCleanupDiagnosticEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (
    env[WINDOWS_CLEANUP_DIAGNOSTIC] === "1" &&
    env[WINDOWS_CLEANUP_DIAGNOSTIC_CASE] === GEMINI_PREVIEW_DIAGNOSTIC_CASE
  );
}

/** The directory and only the known native preview fixture files are registered. */
export function geminiPreviewDiagnosticResources(root: string): string[] {
  const executable =
    process.platform === "win32" ? "inert-gemini.exe" : "inert-gemini";
  const log = join(root, "native.jsonl");
  return [join(root, executable), log, `${log}.control`];
}

/** Ask Restart Manager about only the supplied fixture resources, with a short bound. */
export function restartManagerLockerPids(
  resources: readonly string[],
): number[] | null {
  try {
    const powershell = Bun.which("powershell.exe");
    if (powershell === null || resources.length < 1 || resources.length > 8)
      return null;
    const result = Bun.spawnSync(
      [
        powershell,
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(import.meta.dir, "windows-restart-manager-lockers.ps1"),
        ...resources,
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: 3000,
        windowsHide: true,
      },
    );
    if (result.exitCode !== 0 || result.stdout.byteLength > 4096) return null;
    return parseRestartManagerPids(result.stdout.toString("utf8").trim());
  } catch {
    return null;
  }
}

/** Validate Restart Manager output without retaining any unrelated text. */
export function parseRestartManagerPids(text: string): number[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    const values = Array.isArray(parsed) ? parsed : [parsed];
    if (
      values.length > 256 ||
      values.some(
        (value) =>
          typeof value !== "number" ||
          !Number.isSafeInteger(value) ||
          value < 0,
      )
    )
      return null;
    return [...new Set(values as number[])].sort((a, b) => a - b);
  } catch {
    return null;
  }
}

export function cleanupEvidenceJson(evidence: WindowsCleanupEvidence): string {
  return JSON.stringify({
    diagnostic: "windows-fixture-cleanup",
    case: evidence.case,
    operation: evidence.operation,
    target: evidence.target,
    errorCode: evidence.errorCode,
    liveChildCount: evidence.liveChildCount,
    resources: evidence.resources,
    rootEntries: evidence.rootEntries,
    rootEntriesTruncated: evidence.rootEntriesTruncated,
    lockerPids: evidence.lockerPids,
    lockerProbe: evidence.lockerProbe,
  });
}
