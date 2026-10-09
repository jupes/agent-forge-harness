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
 * A verdict is created once and never replaced: the writer creates the file
 * exclusively. A reader opens it once and returns the bytes with their digest,
 * so what was validated and what was hashed are the same buffer.
 *
 * Kept apart from `eval-verdict.ts` and `run-correlation.ts`, which stay free
 * of Node imports for the dashboard bundle. The directory is gitignored, so a
 * verdict never arrives through a commit.
 */

import { createHash } from "crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
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

/**
 * Create a run's verdict file. Fails, and writes nothing, when the file is
 * already there: a verdict is never replaced, by this or by a second writer
 * that lost the race. `file` is the run's strict verdict unless it names a
 * review round (`reviewVerdictFile`).
 *
 * `checkout` is a directory in the checkout the run builds in. Nothing is
 * created behind a link: every existing part of the path must be the
 * checkout's own, before and after the directory is made.
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
  try {
    if (!statSync(input.checkout).isDirectory()) {
      return { ok: false, error: "the checkout directory does not exist" };
    }
  } catch {
    return { ok: false, error: "the checkout directory does not exist" };
  }
  const root = resolveCheckout(input.checkout).worktree;
  if (!existsSync(join(root, ".git"))) {
    return { ok: false, error: "the directory is not in a git checkout" };
  }
  const linked: WriteVerdictResult = {
    ok: false,
    error: `${EVALUATIONS_DIR} is, or sits under or holds, a link: a verdict is only written in the checkout's own directory`,
  };
  if (!isOwn(root, where.dir)) return linked;

  const path = `${root}/${where.relative}`;
  let fd: number;
  try {
    mkdirSync(`${root}/${where.dir}`, { recursive: true });
    if (!isOwn(root, where.dir)) return linked;
    // Exclusive create: fails when anything is at the path, a link included.
    fd = openSync(path, "wx");
  } catch (error) {
    return errorCode(error) === "EEXIST"
      ? {
          ok: false,
          exists: true,
          error: `a verdict already exists at ${where.relative}: it is written once and never replaced`,
        }
      : {
          ok: false,
          error: `could not create ${where.relative}: ${message(error)}`,
        };
  }
  try {
    let written = 0;
    while (written < data.byteLength) {
      written += writeSync(fd, data, written, data.byteLength - written);
    }
    fsyncSync(fd);
    closeSync(fd);
  } catch (error) {
    // The file is this call's own creation: do not leave half a verdict
    // where a whole one can then never be written.
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
    try {
      unlinkSync(path);
    } catch {
      // Nothing more to do; the reader will refuse what is there.
    }
    return {
      ok: false,
      error: `could not write ${where.relative}: ${message(error)}`,
    };
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
  const { relative } = where;
  const root = resolveCheckout(input.checkout).worktree;
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

  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    if (!fstatSync(fd).isFile()) {
      return refuse(`${relative} is not a regular file`);
    }
    // Room for one more byte than a verdict may have: a larger file is seen
    // without being read.
    const room = Buffer.alloc(MAX_VERDICT_BYTES + 1);
    let length = 0;
    while (length < room.byteLength) {
      const read = readSync(fd, room, length, room.byteLength - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_VERDICT_BYTES) {
      return refuse(`${relative} is larger than ${MAX_VERDICT_BYTES} bytes`);
    }
    const buffer = Buffer.from(room.subarray(0, length));
    return {
      ok: true,
      path: relative,
      buffer,
      sha256: sha256Hex(buffer),
      bytes: length,
    };
  } catch (error) {
    return refuse(`${relative} could not be read: ${message(error)}`);
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
