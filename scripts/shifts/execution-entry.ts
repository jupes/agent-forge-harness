import { agentForgeHome } from "../agent-forge-home";
import { isMain } from "../is-main";
import {
  executeOriginalProjectShift,
  parseProjectShiftExecutionArgs,
} from "./execution";

/** Packaged and source entry share a closed original-id protocol. No provider adapter is enabled in this increment. */
export async function runProjectShiftExecutionEntry(
  args: readonly string[],
): Promise<void> {
  try {
    const input = parseProjectShiftExecutionArgs(args);
    const receipt = await executeOriginalProjectShift({
      ...input,
      root: process.cwd(),
      home: agentForgeHome(),
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

if (isMain(import.meta))
  await runProjectShiftExecutionEntry(process.argv.slice(2));
