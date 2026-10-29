import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  type TerminalHandoffAttempt,
  terminalHandoffAttemptSchema,
} from "../../types/session-terminal-handoff";
import { ConversationError } from "../conversations/error";
import {
  ensurePrivateHome,
  readHomeFile,
  readSessionTranscript,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import type { NativeConsoleChild } from "../providers/native-console";
import {
  launchWindowsConsole,
  NativeConsoleNotStartedError,
} from "../providers/native-console";
import { withQueueLock } from "../scheduler/queue-lock";
import { serializeClaudeInteractiveResume } from "./claude-interactive-resume";

const journalSchema = z
  .object({
    version: z.literal(1),
    attempts: z.array(terminalHandoffAttemptSchema).max(512),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.attempts.map((attempt) => attempt.requestId)).size ===
      value.attempts.length,
  );
type Journal = z.infer<typeof journalSchema>;
export interface TerminalHandoffCandidate {
  projectId: string;
  sessionId: string;
  turnRequestId: string;
  nativeSessionId: string;
  executable: string;
  cwd: string;
  snapshot: Parameters<typeof serializeClaudeInteractiveResume>[0]["snapshot"];
  env: Record<string, string>;
}

const unavailable = () =>
  new ConversationError(
    503,
    "The private terminal handoff record is unavailable. Saved data has been kept; check the original request.",
  );
function canonicalRoot(root: string) {
  let canonical: string;
  try {
    canonical = realpathSync.native(root);
  } catch {
    throw unavailable();
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
/** Durable, one-at-a-time native handoffs. The journal never contains command or transcript bytes. */
export function createSessionTerminalHandoff(options: {
  home: string;
  root: string;
  candidate(
    projectId: string,
    sessionId: string,
  ): Promise<TerminalHandoffCandidate>;
  launch?: typeof launchWindowsConsole;
}) {
  const parent = join(options.home, "session-terminal-handoffs"),
    directory = join(
      parent,
      createHash("sha256")
        .update(canonicalRoot(options.root))
        .digest("hex")
        .slice(0, 32),
    ),
    file = join(directory, "attempts.json"),
    journalLock = join(directory, "attempts.lock.db");
  const active = new Map<
    string,
    { child: NativeConsoleChild; finished: Promise<void> }
  >();
  const unknownRequests = new Set<string>();
  let closing = false;
  const sessionLock = (projectId: string, sessionId: string) =>
    join(
      directory,
      `${createHash("sha256").update(`${projectId}\0${sessionId}`).digest("hex").slice(0, 32)}.session.lock.db`,
    );
  function checkedPaths() {
    for (const [path, directoryPath] of [
      [parent, true],
      [directory, true],
      [file, false],
      [journalLock, false],
    ] as const) {
      try {
        const info = lstatSync(path);
        if (
          info.isSymbolicLink() ||
          (directoryPath
            ? !info.isDirectory()
            : !info.isFile() || info.nlink !== 1)
        )
          throw unavailable();
      } catch (error) {
        if (error instanceof ConversationError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          throw unavailable();
      }
    }
    if (
      readHomeFile(parent).problem !== null ||
      readHomeFile(directory).problem !== null
    )
      throw unavailable();
  }
  function prepareDirectories() {
    ensurePrivateHome(options.home);
    ensurePrivateHome(parent);
    ensurePrivateHome(directory);
  }
  function state(): Journal {
    prepareDirectories();
    checkedPaths();
    const found = readSessionTranscript(options.home, file);
    if (found.problem !== null) throw unavailable();
    if (found.text === null) return { version: 1, attempts: [] };
    let raw: unknown;
    try {
      if (Buffer.byteLength(found.text) > 262_144) throw unavailable();
      raw = JSON.parse(found.text);
    } catch {
      throw unavailable();
    }
    const parsed = journalSchema.safeParse(raw);
    if (!parsed.success) throw unavailable();
    return parsed.data;
  }
  function write(value: Journal) {
    const text = `${JSON.stringify(value)}\n`;
    if (
      !journalSchema.safeParse(value).success ||
      Buffer.byteLength(text) > 262_144
    )
      throw unavailable();
    try {
      writeOwnerOnly(file, text);
    } catch {
      throw unavailable();
    }
  }
  async function locked<T>(work: () => Promise<T>): Promise<T> {
    prepareDirectories();
    checkedPaths();
    const result = await withQueueLock(journalLock, work, { waitMs: 2000 });
    if (!result.ok) throw unavailable();
    return result.value;
  }
  async function withSession<T>(
    projectId: string,
    sessionId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    prepareDirectories();
    checkedPaths();
    const lockPath = sessionLock(projectId, sessionId);
    try {
      const info = lstatSync(lockPath);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1)
        throw unavailable();
    } catch (error) {
      if (error instanceof ConversationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw unavailable();
    }
    const result = await withQueueLock(lockPath, work, {
      waitMs: 2000,
    });
    if (!result.ok)
      throw new ConversationError(
        409,
        "This Chat is busy. Check its original terminal handoff before retrying.",
      );
    return result.value;
  }
  function view(row: TerminalHandoffAttempt): TerminalHandoffAttempt {
    if (unknownRequests.has(row.requestId)) return { ...row, phase: "unknown" };
    if (
      (row.phase === "opening" || row.phase === "opened") &&
      !active.has(row.requestId)
    )
      return { ...row, phase: "unknown" };
    return { ...row };
  }
  async function complete(
    requestId: string,
    result: Awaited<NativeConsoleChild["done"]> | null,
  ) {
    try {
      await locked(async () => {
        const value = state(),
          row = value.attempts.find((item) => item.requestId === requestId);
        if (!row) throw unavailable();
        row.phase = result ? "closed" : "unknown";
        row.endedAt = new Date().toISOString();
        write(value);
        unknownRequests.delete(requestId);
      });
    } catch {
      /* A lost receipt remains held as unknown; it is never replayed. */
    } finally {
      active.delete(requestId);
    }
  }
  return {
    async read(projectId: string, sessionId: string) {
      return withSession(projectId, sessionId, () =>
        locked(async () => {
          const value = state();
          const found = value.attempts
            .filter(
              (attempt) =>
                attempt.projectId === projectId &&
                attempt.sessionId === sessionId,
            )
            .at(-1);
          return { attempt: found ? view(found) : null };
        }),
      );
    },
    blocksAppSend(projectId: string, sessionId: string) {
      return state().attempts.some(
        (attempt) =>
          attempt.projectId === projectId &&
          attempt.sessionId === sessionId &&
          ["opening", "opened", "closed", "unknown"].includes(
            view(attempt).phase,
          ),
      );
    },
    async send(
      projectId: string,
      sessionId: string,
      work: () => Promise<unknown>,
    ) {
      return withSession(projectId, sessionId, async () => {
        if (
          state().attempts.some(
            (attempt) =>
              attempt.projectId === projectId &&
              attempt.sessionId === sessionId &&
              ["opening", "opened", "closed", "unknown"].includes(
                view(attempt).phase,
              ),
          )
        )
          throw new ConversationError(
            409,
            "This Chat has a native terminal handoff. Its terminal activity is not synced, so app sends are held.",
          );
        return work();
      });
    },
    async open(
      projectId: string,
      sessionId: string,
      requestId: string,
      auditEventId: number,
    ): Promise<TerminalHandoffAttempt> {
      if (!z.uuid().safeParse(requestId).success)
        throw new ConversationError(400, "Expected a terminal handoff UUID.");
      if (!Number.isSafeInteger(auditEventId) || auditEventId <= 0)
        throw new ConversationError(
          503,
          "A confirmed operator audit receipt is required before opening a terminal.",
        );
      return withSession(projectId, sessionId, () =>
        locked(async () => {
          const before = state(),
            existing = before.attempts.find(
              (row) => row.requestId === requestId,
            );
          if (existing) {
            if (
              existing.projectId !== projectId ||
              existing.sessionId !== sessionId
            )
              throw new ConversationError(
                409,
                "This request UUID belongs to another terminal handoff.",
              );
            return view(existing);
          }
          if (closing)
            throw new ConversationError(
              503,
              "The terminal service is closing. No terminal was opened.",
            );
          const held = before.attempts.find(
            (row) =>
              row.projectId === projectId &&
              row.sessionId === sessionId &&
              view(row).phase !== "refused",
          );
          if (held)
            throw new ConversationError(
              409,
              "This Chat already has an original terminal handoff. Check that request; a new terminal was not opened.",
            );
          const candidate = await options.candidate(projectId, sessionId);
          if (closing)
            throw new ConversationError(
              503,
              "The terminal service is closing. No terminal was opened.",
            );
          if (
            candidate.projectId !== projectId ||
            candidate.sessionId !== sessionId ||
            !z.uuid().safeParse(candidate.turnRequestId).success ||
            !z.uuid().safeParse(candidate.nativeSessionId).success
          )
            throw new ConversationError(
              409,
              "The saved Claude Chat identity could not be verified.",
            );
          if (before.attempts.length >= 512) throw unavailable();
          const command = serializeClaudeInteractiveResume({
            executable: candidate.executable,
            sessionId: candidate.nativeSessionId,
            snapshot: candidate.snapshot,
          });
          const row: TerminalHandoffAttempt = {
            projectId,
            sessionId,
            turnRequestId: candidate.turnRequestId,
            requestId,
            phase: "opening",
            startedAt: new Date().toISOString(),
            endedAt: null,
            auditEventId,
          };
          before.attempts.push(row);
          write(before);
          let child: NativeConsoleChild;
          try {
            child = (options.launch ?? launchWindowsConsole)({
              command,
              cwd: candidate.cwd,
              env: candidate.env,
              lifetime: { kind: "managed" },
            });
          } catch (error) {
            const refused = error instanceof NativeConsoleNotStartedError;
            row.phase = refused ? "refused" : "unknown";
            row.endedAt = new Date().toISOString();
            write(before);
            if (refused)
              throw new ConversationError(
                409,
                "Windows refused to create the terminal. No CLI was started; you may explicitly review and try again.",
              );
            throw new ConversationError(
              503,
              "The terminal outcome could not be confirmed. Check the original terminal request before trying again.",
            );
          }
          const finished = child.done
            .then(
              (result) => complete(requestId, result),
              () => complete(requestId, null),
            )
            .catch(() => {
              /* A lost receipt remains unknown and cannot be replayed. */
            });
          active.set(requestId, { child, finished });
          row.phase = "opened";
          try {
            write(before);
          } catch {
            row.phase = "unknown";
            unknownRequests.add(requestId);
          }
          return view(row);
        }),
      );
    },
    async close() {
      closing = true;
      await Promise.allSettled(
        [...active.values()].map(async ({ child, finished }) => {
          try {
            await child.stop();
          } catch {
            /* Complete records unknown if native settlement was not confirmed. */
          }
          await finished;
        }),
      );
    },
  };
}
