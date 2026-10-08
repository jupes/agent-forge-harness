/**
 * The model a session is running on, read from the end of its transcript.
 *
 * The fallback for when the host did not report a model at session start: the
 * transcript's assistant records name the model that answered. The transcript
 * format is the host's own and may change, so nothing here throws and anything
 * unexpected reads as "not known". Only a bounded tail is ever read — a
 * transcript can be many megabytes and this runs inside a hook.
 */

import { closeSync, fstatSync, openSync, readSync } from "fs";

/** How much of the end of a transcript is read. */
export const TRANSCRIPT_TAIL_BYTES = 65536;

export interface Tail {
  text: string;
  /** False when the text starts part-way through the file, so its first line may be cut. */
  fromStart: boolean;
}

export interface TranscriptModel {
  model: string;
  effort?: string;
}

/** The last `maxBytes` of a file, or null when it cannot be read. */
export function readTail(path: string, maxBytes: number): Tail | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, size - length);
    return {
      text: buffer.subarray(0, read).toString("utf8"),
      fromStart: size <= maxBytes,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to do about a failed close of a read-only handle.
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

/** An effort level written either as a string or as `{ level }`. */
export function effortOf(value: unknown): string | undefined {
  if (isRecord(value)) return nonEmptyString(value.level);
  return nonEmptyString(value);
}

function modelOfLine(line: string): TranscriptModel | null {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(record) || record.type !== "assistant") return null;
  if (record.isSidechain === true) return null;
  const message = record.message;
  if (!isRecord(message)) return null;
  const model = nonEmptyString(message.model);
  // Records the host writes itself (an error notice, say) carry a bracketed placeholder.
  if (model === undefined || model.startsWith("<")) return null;
  const effort = effortOf(record.effort);
  return { model, ...(effort !== undefined ? { effort } : {}) };
}

/**
 * The model and effort of the last assistant record in the transcript's tail,
 * or null when there is none (no reply yet, file missing, format changed).
 */
export function modelFromTranscriptTail(
  path: string,
  opts: {
    maxBytes?: number;
    read?: (path: string, maxBytes: number) => Tail | null;
  } = {},
): TranscriptModel | null {
  try {
    const tail = (opts.read ?? readTail)(
      path,
      opts.maxBytes ?? TRANSCRIPT_TAIL_BYTES,
    );
    if (tail === null) return null;
    const lines = tail.text.split("\n");
    const first = tail.fromStart ? 0 : 1;
    for (let i = lines.length - 1; i >= first; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      const found = modelOfLine(line);
      if (found) return found;
    }
    return null;
  } catch {
    return null;
  }
}
