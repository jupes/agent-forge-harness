import { lstatSync } from "node:fs";
import { join } from "node:path";
import type {
  ProjectShiftIntent,
  ProjectShiftReceipt,
  ProjectShiftStartRequest,
  ProjectShiftsPage,
} from "../../types/project-shifts";
import { ConversationError } from "../conversations/error";
import { readSessionTranscript } from "../hearth/home-guard";
import {
  isProcessId,
  isShiftId,
  processAlive,
  SHIFTS_DIR,
} from "../scheduler/shift-store";
import { observeProjectShift } from "./observations";
import {
  ATTENDED_SHIFT_UNAVAILABLE,
  projectShiftReceiptSchema,
  projectShiftsPageSchema,
} from "./protocol";
import { createProjectShiftRegistry } from "./registry";

/** Trusted server runtime only. The production facade supplies no attended launcher yet. */
export interface ProjectShiftRuntime {
  attended: true;
  mint(): string;
  launch(intent: ProjectShiftIntent): void | Promise<void>;
  unrecorded?(): unknown[];
}

/** Bounded private evidence by original id; never the global list's truncated, cross-project collection. */
function evidence(home: string, intent: ProjectShiftIntent) {
  const dir = join(home, SHIFTS_DIR),
    file = join(dir, `${intent.shiftId}.json`),
    stop = join(dir, `${intent.shiftId}.stop`);
  try {
    for (const [path, folder] of [
      [dir, true],
      [file, false],
      [stop, false],
    ] as const) {
      try {
        const info = lstatSync(path);
        if (
          info.isSymbolicLink() ||
          (folder ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
        )
          return { record: {} };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          return { record: {} };
      }
    }
    const found = readSessionTranscript(home, file);
    if (found.problem !== null) return { record: {} };
    if (found.text === null) return {};
    let record: unknown;
    try {
      record = JSON.parse(found.text);
    } catch {
      return { record: {} };
    }
    const pid =
      record && typeof record === "object" && "pid" in record
        ? record.pid
        : null;
    let stopRequested = false;
    try {
      stopRequested = lstatSync(stop).isFile();
    } catch {
      /* No stop marker. */
    }
    return {
      record,
      alive: isProcessId(pid) ? processAlive(pid) : false,
      stopRequested,
    };
  } catch {
    return { record: {} };
  }
}

/** The immutable private original is the only project association for a launched shift. Reads never dispatch. */
export function createProjectShiftService(options: {
  home: string;
  root: string;
  validateStart(
    projectId: string,
    request: ProjectShiftStartRequest,
  ): Promise<void>;
  runtime?: ProjectShiftRuntime;
}) {
  const registry = createProjectShiftRegistry(options);
  let closed = false;
  const open = () => {
    if (closed)
      throw new ConversationError(
        503,
        "The shift coordinator is closing. Read the original request before trying anything else.",
      );
  };
  const receipt = (intent: ProjectShiftIntent): ProjectShiftReceipt => {
    const found = evidence(options.home, intent);
    const launch = options.runtime
      ?.unrecorded?.()
      .find(
        (item) =>
          item !== null &&
          typeof item === "object" &&
          "shiftId" in item &&
          item.shiftId === intent.shiftId,
      );
    const result = {
      intent,
      observation: observeProjectShift(intent, {
        ...found,
        ...(launch !== undefined ? { launch } : {}),
      }),
    };
    if (!projectShiftReceiptSchema.safeParse(result).success)
      throw new ConversationError(
        503,
        "The original shift receipt could not be verified. Its saved request has been kept.",
      );
    return result;
  };
  return {
    read(projectId: string, requestId: string): ProjectShiftReceipt {
      return receipt(registry.read(projectId, requestId));
    },
    list(projectId: string): ProjectShiftsPage {
      const page = {
        projectId,
        asOf: new Date().toISOString(),
        items: registry.list(projectId).map(receipt),
      };
      if (
        !projectShiftsPageSchema.safeParse(page).success ||
        Buffer.byteLength(JSON.stringify(page)) > 4_194_304
      )
        throw new ConversationError(
          503,
          "The project shift read exceeds its verified limits. Original request identities have been kept.",
        );
      return page;
    },
    authorizeControl(projectId: string, shiftId: string): ProjectShiftReceipt {
      if (!isShiftId(shiftId))
        throw new ConversationError(400, "Expected a shift id.");
      const intent = registry
        .list(projectId)
        .find((item) => item.shiftId === shiftId);
      if (!intent)
        throw new ConversationError(
          404,
          "No original project Start names this shift in this workspace.",
        );
      const current = receipt(intent);
      if (current.observation.actual === null)
        throw new ConversationError(
          409,
          "The actual original shift record could not be verified. Check the original request before using its controls.",
        );
      return current;
    },
    async start(
      projectId: string,
      request: ProjectShiftStartRequest,
    ): Promise<ProjectShiftReceipt> {
      open();
      const saved = await registry.reserve(projectId, request, async () => {
        open();
        if (options.runtime?.attended !== true)
          throw new ConversationError(503, ATTENDED_SHIFT_UNAVAILABLE);
        await options.validateStart(projectId, request);
        open();
        return { shiftId: options.runtime.mint() };
      });
      // An exact retry can observe an intent left at any crash point, but can never launch it again.
      if (!saved.created || closed) return receipt(saved.intent);
      const marked = await registry.markAttempted(
        projectId,
        request.requestId,
        saved.intent.requestHash,
      );
      if (marked.created && !closed) {
        try {
          await options.runtime?.launch(marked.intent);
        } catch {
          /* The durable truth may already have advanced. Read it; never infer refusal or repeat. */
        }
      }
      return receipt(marked.intent);
    },
    close() {
      closed = true;
    },
  };
}
