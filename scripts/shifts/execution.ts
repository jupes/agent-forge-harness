import { join } from "node:path";
import type {
  ProjectShiftIntent,
  ProjectShiftReceipt,
} from "../../types/project-shifts";
import { ConversationError } from "../conversations/error";
import { isProjectId } from "../projects/store";
import { SHIFTS_DIR, shiftIdInUse } from "../scheduler/shift-store";
import { ATTENDED_SHIFT_UNAVAILABLE, shiftRequestIdSchema } from "./protocol";
import { createProjectShiftRegistry } from "./registry";
import { createProjectShiftService } from "./service";

export function parseProjectShiftExecutionArgs(args: readonly string[]): {
  projectId: string;
  requestId: string;
} {
  const [projectId, requestId] = args;
  if (
    args.length !== 2 ||
    !isProjectId(projectId) ||
    !shiftRequestIdSchema.safeParse(requestId).success ||
    requestId === undefined
  )
    throw new ConversationError(
      400,
      "Expected only a project id and original Start UUID.",
    );
  return { projectId, requestId };
}

/** Trusted child runtime only. HTTP and command-line callers cannot supply this capability. */
export interface ProjectShiftExecutionRuntime {
  attended: true;
  prepare(intent: ProjectShiftIntent): Promise<void>;
  run(intent: ProjectShiftIntent): Promise<void>;
}

/** One compiled-child engine entry, authorized by the original audited launch attempt, never by a reservation alone. */
export async function executeOriginalProjectShift(options: {
  home: string;
  root: string;
  projectId: string;
  requestId: string;
  runtime?: ProjectShiftExecutionRuntime;
}): Promise<ProjectShiftReceipt> {
  const registry = createProjectShiftRegistry(options),
    intent = registry.read(options.projectId, options.requestId);
  const reads = createProjectShiftService({
    home: options.home,
    root: options.root,
    validateStart: async () => {},
  });
  const current = () => reads.read(options.projectId, options.requestId);
  // A repeated child command only observes the original. It cannot revalidate into another engine entry.
  if (
    intent.executionStartedAt ||
    intent.startupStop ||
    shiftIdInUse(join(options.home, SHIFTS_DIR), intent.shiftId)
  )
    return current();
  if (options.runtime?.attended !== true)
    throw new ConversationError(503, ATTENDED_SHIFT_UNAVAILABLE);
  const claimed = await registry.claimExecution(
    options.projectId,
    options.requestId,
    intent.requestHash,
  );
  if (!claimed.created) return current();
  try {
    await options.runtime.prepare(claimed.intent);
    await options.runtime.run(claimed.intent);
  } catch {
    /* Preparation or execution may already have changed durable state. Retain the claim and expose only read-derived truth. */
  }
  return current();
}
