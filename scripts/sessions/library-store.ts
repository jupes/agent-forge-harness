import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { OwnedCodingSessionRecord } from "../../types/codex-owned-task";
import type {
  SessionArchiveRequest,
  SessionLibraryEntry,
  SessionLibraryRead,
} from "../../types/session-library";
import { ConversationError } from "../conversations/error";
import {
  ensurePrivateHome,
  readHomeFile,
  readSessionTranscript,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { withQueueLock } from "../scheduler/queue-lock";
import {
  sessionArchiveReceiptSchema,
  sessionArchiveRequestSchema,
  sessionLibraryEntrySchema,
} from "./library-protocol";

export const MAX_SESSION_LIBRARY_BYTES = 4 * 1024 * 1024;
export const MAX_SESSION_LIBRARY_REQUESTS = 4096;
export const sessionLibraryFile = (home: string) =>
  join(home, "sessions", "library.json");
const storedEntry = z
  .object({
    entry: sessionLibraryEntrySchema,
    workspace: z.string().min(1).max(1024),
    receipts: z
      .array(sessionArchiveReceiptSchema)
      .max(MAX_SESSION_LIBRARY_REQUESTS),
  })
  .strict()
  .refine(({ entry, receipts }) => {
    let revision = 0,
      archived = false;
    let updatedAt: string | null = null;
    for (const receipt of receipts) {
      if (
        receipt.projectId !== entry.projectId ||
        receipt.sessionId !== entry.sessionId ||
        receipt.startRequestId !== entry.startRequestId ||
        receipt.startRequestHash !== entry.startRequestHash
      )
        return false;
      if (receipt.outcome === "applied") {
        revision++;
        archived = receipt.original.archived;
        updatedAt = receipt.at;
      }
      if (receipt.revision !== revision || receipt.archived !== archived)
        return false;
    }
    return (
      entry.revision === revision &&
      entry.archived === archived &&
      entry.updatedAt === updatedAt
    );
  });
const schema = z
  .object({
    version: z.literal(1),
    entries: z.array(storedEntry).max(1000),
  })
  .strict()
  .refine((value) => {
    const ids = value.entries.flatMap((entry) =>
      entry.receipts.map((receipt) => receipt.original.requestId),
    );
    return (
      ids.length <= MAX_SESSION_LIBRARY_REQUESTS &&
      new Set(ids).size === ids.length &&
      new Set(value.entries.map(({ entry }) => entry.sessionId)).size ===
        value.entries.length
    );
  });
type State = z.infer<typeof schema>;

function initial(session: OwnedCodingSessionRecord): SessionLibraryEntry {
  return {
    projectId: session.projectId,
    sessionId: session.id,
    startRequestId: session.requestId,
    startRequestHash: session.requestHash,
    revision: 0,
    archived: false,
    updatedAt: null,
  };
}
function matches(
  session: OwnedCodingSessionRecord,
  stored: z.infer<typeof storedEntry>,
) {
  const entry = stored.entry;
  return (
    entry.projectId === session.projectId &&
    entry.sessionId === session.id &&
    entry.startRequestId === session.requestId &&
    entry.startRequestHash === session.requestHash &&
    stored.workspace === session.workspace
  );
}

/** Archive preferences and original receipts never modify a session or provider journal. */
export function createSessionLibraryStore(options: {
  home: string;
  now: () => Date;
  lookup(projectId: string, sessionId: string): OwnedCodingSessionRecord;
  persist?: typeof writeOwnerOnly;
}) {
  const directory = join(options.home, "sessions");
  const lock = join(directory, "library.lock.db");
  const file = sessionLibraryFile(options.home);
  const checked = () => {
    for (const [path, folder] of [
      [directory, true],
      [lock, false],
    ] as const) {
      try {
        const info = lstatSync(path);
        if (
          info.isSymbolicLink() ||
          (folder ? !info.isDirectory() : !info.isFile())
        )
          throw new ConversationError(
            503,
            "The private session library path is linked or invalid. Saved data has been kept.",
          );
      } catch (error) {
        if (error instanceof ConversationError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw new ConversationError(
            503,
            "The private session library path could not be checked.",
          );
      }
    }
    if (readHomeFile(directory).problem !== null)
      throw new ConversationError(
        503,
        "The session library directory is not private. Saved data has been kept.",
      );
  };
  const readState = (): State => {
    checked();
    const found = readSessionTranscript(options.home, file);
    if (found.problem !== null)
      throw new ConversationError(
        503,
        "The private session library could not be read. Saved data has been kept.",
      );
    if (found.text === null) return { version: 1, entries: [] };
    try {
      if (Buffer.byteLength(found.text) > MAX_SESSION_LIBRARY_BYTES)
        throw Error("Full");
      const raw: unknown = JSON.parse(found.text);
      const parsed = schema.safeParse(raw);
      if (parsed.success) return parsed.data;
    } catch {
      /* A malformed private preference never becomes an empty library. */
    }
    throw new ConversationError(
      503,
      "The private session library is invalid, full or unsupported. Saved data has been kept.",
    );
  };
  const selected = (state: State, session: OwnedCodingSessionRecord) => {
    const stored = state.entries.find(
      ({ entry }) => entry.sessionId === session.id,
    );
    if (stored && !matches(session, stored))
      throw new ConversationError(
        409,
        "This library preference belongs to a different original session. Saved data has been kept.",
      );
    return stored;
  };
  const read = (
    session: OwnedCodingSessionRecord,
    requestId?: string,
  ): SessionLibraryRead => {
    const stored = selected(readState(), session);
    const receipt =
      stored?.receipts.find((item) => item.original.requestId === requestId) ??
      null;
    if (requestId && !receipt)
      throw new ConversationError(
        404,
        "The original archive change is not recorded in this read. Keep its original request before retrying.",
      );
    return { entry: stored?.entry ?? initial(session), receipt };
  };
  return {
    read,
    list(sessions: OwnedCodingSessionRecord[]) {
      const state = readState();
      return sessions.map(
        (session) => selected(state, session)?.entry ?? initial(session),
      );
    },
    async archive(
      projectId: string,
      sessionId: string,
      raw: SessionArchiveRequest,
    ): Promise<SessionLibraryRead> {
      const parsed = sessionArchiveRequestSchema.safeParse(raw);
      if (!parsed.success)
        throw new ConversationError(
          400,
          "Expected the original archive UUID, revision and preference.",
        );
      const request = parsed.data;
      options.lookup(projectId, sessionId);
      checked();
      ensurePrivateHome(directory);
      const result = await withQueueLock(
        lock,
        async () => {
          const session = options.lookup(projectId, sessionId);
          const state = readState();
          let stored = selected(state, session);
          const previous = state.entries
            .flatMap((item) => item.receipts)
            .find((item) => item.original.requestId === request.requestId);
          if (previous) {
            if (
              previous.projectId !== projectId ||
              previous.sessionId !== sessionId ||
              previous.original.archived !== request.archived ||
              previous.original.expectedRevision !== request.expectedRevision
            )
              throw new ConversationError(
                409,
                "This archive UUID already names a different original change.",
              );
            return {
              entry: stored?.entry ?? initial(session),
              receipt: previous,
            };
          }
          if (!stored) {
            stored = {
              entry: initial(session),
              workspace: session.workspace,
              receipts: [],
            };
            state.entries.push(stored);
          }
          const at = options.now().toISOString();
          const applied = stored.entry.revision === request.expectedRevision;
          if (applied)
            stored.entry = {
              ...stored.entry,
              revision: stored.entry.revision + 1,
              archived: request.archived,
              updatedAt: at,
            };
          const receipt = {
            projectId,
            sessionId,
            startRequestId: session.requestId,
            startRequestHash: session.requestHash,
            original: request,
            outcome: applied ? ("applied" as const) : ("refused" as const),
            revision: stored.entry.revision,
            archived: stored.entry.archived,
            at,
            reason: applied
              ? null
              : "The archive preference changed. Read its current revision before making another explicit change.",
          };
          stored.receipts.push(receipt);
          const text = `${JSON.stringify(state)}\n`;
          if (
            Buffer.byteLength(text) > MAX_SESSION_LIBRARY_BYTES ||
            !schema.safeParse(state).success
          )
            throw new ConversationError(
              503,
              "The session library is full or invalid. The change was not written.",
            );
          try {
            (options.persist ?? writeOwnerOnly)(file, text);
          } catch {
            throw new ConversationError(
              503,
              "The archive result could not be confirmed. Check the original change before retrying.",
            );
          }
          const confirmed = read(session, request.requestId);
          if (JSON.stringify(confirmed.receipt) !== JSON.stringify(receipt))
            throw new ConversationError(
              503,
              "The original archive change could not be confirmed. Check it before retrying.",
            );
          return confirmed;
        },
        { waitMs: 1000 },
      );
      if (!result.ok)
        throw new ConversationError(
          503,
          "The session library is busy or unavailable. Check the original change before retrying.",
        );
      return result.value;
    },
  };
}
