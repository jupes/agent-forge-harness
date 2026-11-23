import { ConversationError } from "../conversations/error";
import type { ShiftStarts } from "../hearth/shift-launcher";
import type { ProjectShiftRuntime } from "./service";

/** The host supplies the fixed source/packaged attended child entry. Public callers supply only original ids. */
export function createAttendedProjectShiftLauncher(
  starts: Pick<
    ShiftStarts,
    "mint" | "startProject" | "stopProject" | "unrecorded"
  >,
): ProjectShiftRuntime {
  return {
    attended: true,
    mint: () => starts.mint(),
    launch(intent) {
      const launched = starts.startProject(
        intent.projectId,
        intent.request.requestId,
      );
      if (!launched.ok)
        throw new ConversationError(
          503,
          "The original shift launch outcome is unavailable. Read its saved request; it will not be launched again automatically.",
        );
    },
    unrecorded: () => starts.unrecorded(),
    stopStarting: (intent) => starts.stopProject(intent),
  };
}
