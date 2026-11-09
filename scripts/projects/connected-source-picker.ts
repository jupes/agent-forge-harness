import { isAbsolute } from "node:path";
import { z } from "zod";
import type { NativeSourcePicker } from "./connected-source-service";
import { runNativeFolderCommand } from "./repository-onboarding";
import { ProjectStoreError } from "./store";

/** Fixed distinct native protocol. The dialog opens only inside an explicit action. */
export function nativeWorkspaceSourcePicker(
  command: readonly string[] | undefined,
  cwd: string,
): NativeSourcePicker | undefined {
  if (
    !command ||
    command.length !== 2 ||
    !isAbsolute(command[0] ?? "") ||
    command[1] !== "--authorize-project-source"
  )
    return undefined;
  const fixed = [...command];
  return async (signal) => {
    try {
      const result = await runNativeFolderCommand(fixed, cwd, signal);
      let raw: unknown;
      try {
        raw = JSON.parse(result.stdout);
      } catch {
        throw Error();
      }
      const value = z
        .object({
          ok: z.literal(true),
          data: z
            .object({ path: z.string().min(1).max(4096).nullable() })
            .strict(),
          error: z.null(),
        })
        .strict()
        .parse(raw);
      if (result.exitCode !== 0 || signal.aborted) throw Error();
      return value.data.path;
    } catch {
      throw new ProjectStoreError(
        503,
        "Native workspace source consent could not be verified; no new grant was added.",
      );
    }
  };
}
