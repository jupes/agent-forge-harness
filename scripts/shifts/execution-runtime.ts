import { agentForgeHome } from "../agent-forge-home";
import type { CompleteTrackerReader } from "../projects/complete-tracker-reader";
import {
  type AttendedProjectShiftCommands,
  createAttendedProjectShiftExecutionRuntime,
} from "./attended-runtime";
import {
  executeOriginalProjectShift,
  parseProjectShiftExecutionArgs,
} from "./execution";

/** Packaged and source entry share one closed original-id protocol and the trusted attended adapter. */
export async function runProjectShiftExecutionEntry(
  args: readonly string[],
  commands: AttendedProjectShiftCommands = {},
  completeTracker?: CompleteTrackerReader,
): Promise<void> {
  try {
    const input = parseProjectShiftExecutionArgs(args);
    const root = process.cwd(),
      home = agentForgeHome();
    const receipt = await executeOriginalProjectShift({
      ...input,
      root,
      home,
      runtime: createAttendedProjectShiftExecutionRuntime({
        root,
        home,
        commands,
        ...(completeTracker ? { completeTracker } : {}),
      }),
    });
    process.stdout.write(
      `${JSON.stringify({ ok: true, data: receipt, error: null })}\n`,
    );
  } catch {
    process.stdout.write(
      `${JSON.stringify({ ok: false, data: null, error: "The original project shift could not be executed. Check its protected original request; no automatic retry will be made." })}\n`,
    );
    process.exitCode = 1;
  }
}
