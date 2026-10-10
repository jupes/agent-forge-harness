/**
 * Evaluator verdicts on disk: where a run's verdict lives, and the one writer
 * and the one reader of that place.
 *
 * The place is a rule, not a stored field. A run's verdict is
 * `.tmp/work/evaluations/<sha256 of its execution run id>/verdict.json` in the
 * checkout the run builds in, so the run correlation that names the run names
 * its verdict path too, and two runs of one Beads issue never share a file.
 * The id is hashed so that any run id is one safe path segment, and ids that
 * differ only in case stay apart on a case-insensitive disk.
 *
 * A verdict is created once and never replaced, and is whole or absent: the
 * writer writes it beside its place and hard-links it in, which fails when
 * the place is taken. A reader opens it once and returns the bytes with their
 * digest, so what was validated and what was hashed are the same buffer.
 *
 * Kept apart from `eval-verdict.ts` and `run-correlation.ts`, which stay free
 * of Node imports for the dashboard bundle. The directory is gitignored, so a
 * verdict never arrives through a commit.
 */

import { createHash } from "crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from "fs";
import { join } from "path";
import { parseEvalVerdictJson, verdictForRun } from "./eval-verdict";
import { comparableCheckout, isValidSlug } from "./forge/runs";
import { resolveCheckout } from "./ledger/workspace";

/** Repo-relative directory holding one directory per evaluated run. */
export const EVALUATIONS_DIR = ".tmp/work/evaluations";

/** The run's evaluator verdict: the file the strict gate reads. */
export const STRICT_VERDICT_FILE = "verdict.json";

/** A verdict is a few short fields and a summary; anything larger is not one. */
export const MAX_VERDICT_BYTES = 64 * 1024;

const REVIEW_LABEL = /^[a-z0-9][a-z0-9-]{0,39}$/;
const REVIEW_FILE = /^review-[a-z0-9][a-z0-9-]{0,39}\.json$/;

/** Lower-case hex SHA-256. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Repo-relative directory of a run's verdicts, or null when the id cannot name a run. */
export function evaluationDir(executionRunId: string): string | null {
  return isValidSlug(executionRunId)
    ? `${EVALUATIONS_DIR}/${sha256Hex(executionRunId)}`
    : null;
}

/**
 * The declared path of a run's evaluator verdict, relative to its checkout, or
 * null when the id cannot name a run. This is the only place the strict gate
 * looks, and it takes the id only from the run correlation.
 */
export function evaluatorVerdictPath(executionRunId: string): string | null {
  const dir = evaluationDir(executionRunId);
  return dir === null ? null : `${dir}/${STRICT_VERDICT_FILE}`;
}

/** The file name of a review round's verdict, or null when the label cannot name one. */
export function reviewVerdictFile(label: string): string | null {
  return REVIEW_LABEL.test(label) ? `review-${label}.json` : null;
}

/** True for the file names an evaluation directory holds: the run's verdict and its review rounds. */
export function isManagedVerdictFile(name: string): boolean {
  return name === STRICT_VERDICT_FILE || REVIEW_FILE.test(name);
}

export type WriteVerdictResult =
  | {
      ok: true;
      /** Relative to the checkout. */
      path: string;
      sha256: string;
      bytes: number;
    }
  | {
      ok: false;
      error: string;
      /** Set when the file was already there: nothing was written. */
      exists?: true;
    };

export type ReadVerdictResult =
  | {
      ok: true;
      /** Relative to the checkout. */
      path: string;
      /** The bytes that were read: parse these, hash these. */
      buffer: Buffer;
      /** SHA-256 of `buffer`. */
      sha256: string;
      bytes: number;
    }
  | {
      ok: false;
      error: string;
      /** Set when there is no file at the path. */
      missing?: true;
    };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

/**
 * True when `relative`, as far as it exists under the checkout root, is the
 * checkout's own: no part of it is a link, wherever the link leads. A link
 * that leads nowhere counts as a link.
 */
function isOwn(root: string, relative: string): boolean {
  let path = root;
  for (const part of relative.split("/")) {
    path = `${path}/${part}`;
    try {
      lstatSync(path);
    } catch {
      // Not there, so neither is anything below it.
      return true;
    }
    try {
      if (comparableCheckout(realpathSync.native(path)) !== path) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** The repo-relative file for a run and a managed file name, or why there is none. */
function managedPath(
  executionRunId: string,
  file: string,
): { ok: true; dir: string; relative: string } | { ok: false; error: string } {
  const dir = evaluationDir(executionRunId);
  if (dir === null) {
    return { ok: false, error: "executionRunId must be a Forge run id" };
  }
  if (!isManagedVerdictFile(file)) {
    return {
      ok: false,
      error: "the file is not a verdict file of an evaluation directory",
    };
  }
  return { ok: true, dir, relative: `${dir}/${file}` };
}

/** What `readBounded` found at a path it was allowed to open. */
type Bounded =
  | { ok: true; buffer: Buffer }
  | { ok: false; reason: "too-large" | "unreadable"; detail?: string };

/**
 * One open and one read of at most `MAX_VERDICT_BYTES`: a larger file is seen
 * without being taken in.
 */
function readBounded(path: string): Bounded {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    // Room for one more byte than a verdict may have.
    const room = Buffer.alloc(MAX_VERDICT_BYTES + 1);
    let length = 0;
    while (length < room.byteLength) {
      const read = readSync(fd, room, length, room.byteLength - length, null);
      if (read === 0) break;
      length += read;
    }
    return length > MAX_VERDICT_BYTES
      ? { ok: false, reason: "too-large" }
      : { ok: true, buffer: Buffer.from(room.subarray(0, length)) };
  } catch (error) {
    return { ok: false, reason: "unreadable", detail: message(error) };
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

/**
 * Read a verdict file a caller named, at any path, once and bounded: what
 * `forge:review` is given with `--verdict`. Nothing about where the file is
 * is checked here; the caller binds it by what its bytes say.
 */
export function readVerdictFileAt(
  path: string,
):
  | { ok: true; buffer: Buffer; sha256: string; bytes: number }
  | { ok: false; error: string } {
  const read = readBounded(path);
  if (!read.ok) {
    return {
      ok: false,
      error:
        read.reason === "too-large"
          ? `${path} is larger than ${MAX_VERDICT_BYTES} bytes`
          : `could not read ${path}`,
    };
  }
  return {
    ok: true,
    buffer: read.buffer,
    sha256: sha256Hex(read.buffer),
    bytes: read.buffer.byteLength,
  };
}

/**
 * Create a run's verdict file. Fails, and writes nothing, when the file is
 * already there: a verdict is never replaced, by this or by a second writer
 * that lost the race. `file` is the run's strict verdict unless it names a
 * review round (`reviewVerdictFile`).
 *
 * The place is the run's only one, so only that run's verdict goes in it:
 * `content` must parse as a schema 2 verdict naming `executionRunId`.
 *
 * `checkout` is the top level of the checkout the run builds in. Nothing is
 * created behind a link: every existing part of the path must be the
 * checkout's own, before and after the directory is made.
 *
 * The bytes are written to a scratch file beside the place and hard-linked
 * into it, so the verdict appears whole or not at all, and a writer that dies
 * part-way leaves only its scratch file.
 */
export function writeVerdictOnce(input: {
  checkout: string;
  executionRunId: string;
  file?: string;
  content: string;
}): WriteVerdictResult {
  const where = managedPath(
    input.executionRunId,
    input.file ?? STRICT_VERDICT_FILE,
  );
  if (!where.ok) return where;
  const data = Buffer.from(input.content, "utf8");
  if (data.byteLength > MAX_VERDICT_BYTES) {
    return {
      ok: false,
      error: `the verdict is larger than ${MAX_VERDICT_BYTES} bytes`,
    };
  }
  const parsed = parseEvalVerdictJson(input.content);
  const mine = parsed.ok
    ? verdictForRun(parsed.value, { executionRunId: input.executionRunId })
    : parsed;
  if (!mine.ok) {
    return {
      ok: false,
      error: `the content is not a schema 2 verdict for this run: ${mine.error}`,
    };
  }

  let given: string;
  try {
    if (!statSync(input.checkout).isDirectory()) {
      return { ok: false, error: "the checkout directory does not exist" };
    }
    given = comparableCheckout(realpathSync.native(input.checkout));
  } catch {
    return { ok: false, error: "the checkout directory does not exist" };
  }
  const root = resolveCheckout(input.checkout).worktree;
  if (!existsSync(join(root, ".git"))) {
    return { ok: false, error: "the directory is not in a git checkout" };
  }
  // A directory named as the checkout is that checkout, not whichever one
  // encloses it: a verdict is never filed somewhere nobody asked for.
  if (given !== root) {
    return {
      ok: false,
      error: "the directory is not the top level of a checkout",
    };
  }
  const linked: WriteVerdictResult = {
    ok: false,
    error: `${EVALUATIONS_DIR} is, or sits under or holds, a link: a verdict is only written in the checkout's own directory`,
  };
  if (!isOwn(root, where.dir)) return linked;
  try {
    mkdirSync(`${root}/${where.dir}`, { recursive: true });
  } catch (error) {
    return {
      ok: false,
      error: `could not create ${where.dir}: ${message(error)}`,
    };
  }
  if (!isOwn(root, where.dir)) return linked;

  const path = `${root}/${where.relative}`;
  const scratch = `${root}/${where.dir}/.${input.file ?? STRICT_VERDICT_FILE}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    const fd = openSync(scratch, "wx");
    try {
      let written = 0;
      while (written < data.byteLength) {
        written += writeSync(fd, data, written, data.byteLength - written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // The create-once step: a hard link is made only where nothing is, and
    // what it names is already whole.
    linkSync(scratch, path);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") {
      return {
        ok: false,
        error: `could not write ${where.relative}: ${message(error)}`,
      };
    }
    let regular = false;
    try {
      regular = lstatSync(path).isFile();
    } catch {
      // Gone again, or not readable: reported as in the way.
    }
    return regular
      ? {
          ok: false,
          exists: true,
          error: `a verdict already exists at ${where.relative}: it is written once and never replaced`,
        }
      : {
          ok: false,
          error: `${where.relative} is in the way and is not a regular file`,
        };
  } finally {
    try {
      unlinkSync(scratch);
    } catch {
      // Never created, or already gone.
    }
  }
  return {
    ok: true,
    path: where.relative,
    sha256: sha256Hex(data),
    bytes: data.byteLength,
  };
}

/**
 * Read a run's verdict file once: one open, one buffer, and that buffer's
 * digest. `file` is the run's strict verdict unless it names a review round.
 *
 * Refused before the file is opened: a path that is, or sits under, a link
 * (inside the checkout or out of it), and anything that is not a regular
 * file. Refused after: more bytes than a verdict has.
 */
export function readVerdictOnce(input: {
  checkout: string;
  executionRunId: string;
  file?: string;
}): ReadVerdictResult {
  const where = managedPath(
    input.executionRunId,
    input.file ?? STRICT_VERDICT_FILE,
  );
  if (!where.ok) return where;
  return readOwnFile(resolveCheckout(input.checkout).worktree, where.relative);
}

const EVALUATION_DIR_NAME = /^[0-9a-f]{64}$/;

/** True for a directory name the path rule can produce: 64 lower-case hex digits. */
export function isEvaluationDirName(name: string): boolean {
  return EVALUATION_DIR_NAME.test(name);
}

/**
 * Read one file of an evaluation directory by the directory's name rather
 * than by a run id: what a sweep has in hand. Refuses what `readVerdictOnce`
 * refuses, and any directory or file name the path rule cannot produce.
 */
export function readEvaluationFile(input: {
  checkout: string;
  dir: string;
  file: string;
}): ReadVerdictResult {
  if (!isEvaluationDirName(input.dir) || !isManagedVerdictFile(input.file)) {
    return {
      ok: false,
      error: "the file is not a verdict file of an evaluation directory",
    };
  }
  return readOwnFile(
    resolveCheckout(input.checkout).worktree,
    `${EVALUATIONS_DIR}/${input.dir}/${input.file}`,
  );
}

/** One bounded read of `relative` under the checkout root, refused behind any link. */
function readOwnFile(root: string, relative: string): ReadVerdictResult {
  const path = `${root}/${relative}`;
  const refuse = (error: string): ReadVerdictResult => ({ ok: false, error });

  let regular: boolean;
  try {
    regular = lstatSync(path).isFile();
  } catch {
    return {
      ok: false,
      missing: true,
      error: `no evaluator verdict at ${relative}`,
    };
  }
  let real: string | null = null;
  try {
    real = comparableCheckout(realpathSync.native(path));
  } catch {
    // There, and leading nowhere.
  }
  if (real !== path) {
    return refuse(
      `${relative} is, or sits under, a link: a verdict is only read from the checkout's own directory`,
    );
  }
  if (!regular) return refuse(`${relative} is not a regular file`);

  const read = readBounded(path);
  if (!read.ok) {
    return refuse(
      read.reason === "too-large"
        ? `${relative} is larger than ${MAX_VERDICT_BYTES} bytes`
        : `${relative} could not be read: ${read.detail}`,
    );
  }
  return {
    ok: true,
    path: relative,
    buffer: read.buffer,
    sha256: sha256Hex(read.buffer),
    bytes: read.buffer.byteLength,
  };
}
