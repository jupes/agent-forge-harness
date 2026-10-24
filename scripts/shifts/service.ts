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

/** Trusted server runtime only; a launch marker is distinct from an actual private provider turn. */
export interface ProjectShiftRuntime {
  attended: true;
  mint(): string;
  launch(intent: ProjectShiftIntent): void | Promise<void>;
  /** True only after the matching locally held startup tree has settled. No persisted PID grants this capability. */
  stopStarting?(intent: ProjectShiftIntent): Promise<boolean>;
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
  const stops = new Map<string, Promise<ProjectShiftReceipt | null>>();
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
  const originalFor = (projectId: string, shiftId: string) => {
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
    return intent;
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
      const intent = originalFor(projectId, shiftId);
      const current = receipt(intent);
      if (current.observation.actual === null)
        throw new ConversationError(
          409,
          "The actual original shift record could not be verified. Check the original request before using its controls.",
        );
      return current;
    },
    /** Null delegates to the canonical record's existing Stop/Recover authority. */
    async stopStarting(
      projectId: string,
      shiftId: string,
    ): Promise<ProjectShiftReceipt | null> {
      open();
      const intent = originalFor(projectId, shiftId);
      if (receipt(intent).observation.actual !== null) return null;
      if (intent.startupStop?.completedAt) return receipt(intent);
      const key = `${projectId}/${intent.request.requestId}/${intent.requestHash}`;
      const previous = stops.get(key);
      if (previous) return previous;
      const pending = (async () => {
        const marked = await registry.requestStartupStop(intent);
        // A record published during the private write wins; keep its canonical cleanup controls.
        if (evidence(options.home, marked.intent).record !== undefined) {
          const observed = receipt(marked.intent);
          return observed.observation.actual !== null ? null : observed;
        }
        try {
          const settled = await options.runtime?.stopStarting?.(marked.intent);
          if (
            settled === true &&
            evidence(options.home, marked.intent).record === undefined
          ) {
            await registry.completeStartupStop(marked.intent);
          }
        } catch {
          /* A held tree may already have ended. Only the durable receipt may confirm completion. */
        }
        return receipt(registry.read(projectId, intent.request.requestId));
      })();
      stops.set(key, pending);
      try {
        return await pending;
      } finally {
        stops.delete(key);
      }
    },
    async start(
      projectId: string,
      request: ProjectShiftStartRequest,
    ): Promise<ProjectShiftReceipt> {
      open();
      const saved = await registry.reserve(
        projectId,
        request,
        async (reviewed) => {
          open();
          if (options.runtime?.attended !== true)
            throw new ConversationError(503, ATTENDED_SHIFT_UNAVAILABLE);
          await options.validateStart(projectId, reviewed);
          open();
          return { shiftId: options.runtime.mint() };
        },
      );
      // An exact retry can observe an intent left at any crash point, but can never launch it again.
      if (!saved.created || closed) return receipt(saved.intent);
      const marked = await registry.markAttempted(
        projectId,
        saved.intent.request.requestId,
        saved.intent.requestHash,
      );
      if (marked.created && !closed) {
        try {
          await options.runtime?.launch(marked.intent);
        } catch {
          /* The durable truth may already have advanced. Read it; never infer refusal or repeat. */
        }
      }
      return receipt(registry.read(projectId, saved.intent.request.requestId));
    },
    close() {
      closed = true;
    },
  };
}
