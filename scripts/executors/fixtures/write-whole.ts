/**
 * How the stand-in CLI writes the files a test reads back (`--fake-dump`,
 * `--fake-attach`).
 */

import { renameSync, writeFileSync } from "fs";

/** The file operations `writeWhole` uses: the real ones, or a test's. */
export interface WriteIo {
  writeFileSync(path: string, text: string): void;
  renameSync(from: string, to: string): void;
}

const realIo: WriteIo = { writeFileSync, renameSync };

/**
 * Write `text` to `path` so that a reader finds it whole or not at all: the
 * text goes to a draft beside `path`, which is then renamed onto it. A plain
 * write creates the file before the text is in it, and a test that kills the
 * child (a hung child at its timeout) can end it in between, leaving an empty
 * file; on Windows, under load, that was seen (`gf3s`). A write cut short
 * leaves only the draft.
 */
export function writeWhole(
  path: string,
  text: string,
  io: WriteIo = realIo,
): void {
  const draft = `${path}.${process.pid}.draft`;
  io.writeFileSync(draft, text);
  io.renameSync(draft, path);
}
