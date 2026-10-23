import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

const unavailable = () =>
  new Error(
    "A supported Gemini CLI installation is unavailable. Windows npm installs require the official package and a native Node executable; no shell shim was executed.",
  );
const regular = (path: string, followExecutableLink = false): string => {
  if (!isAbsolute(path) || path.length > 4096 || path.includes("\0"))
    throw unavailable();
  const info = lstatSync(path);
  if (!info.isFile() && !(followExecutableLink && info.isSymbolicLink()))
    throw unavailable();
  const resolved = realpathSync.native(path);
  if (!lstatSync(resolved).isFile()) throw unavailable();
  return resolved;
};
function packageData(path: string): unknown {
  const file = regular(path);
  const descriptor = openSync(file, "r");
  try {
    if (fstatSync(descriptor).size > 65_536) throw unavailable();
    const buffer = Buffer.alloc(65_537);
    let count = 0;
    for (;;) {
      const size = readSync(
        descriptor,
        buffer,
        count,
        buffer.byteLength - count,
        null,
      );
      count += size;
      if (count > 65_536) throw unavailable();
      if (!size) break;
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(0, count),
        ),
      );
    } catch {
      throw unavailable();
    }
  } finally {
    closeSync(descriptor);
  }
}

/** Resolves a trusted installed CLI; it never interprets or executes shell shim text. */
export function resolveGeminiCommand(
  options: { platform?: string; which?: (name: string) => string | null } = {},
): string[] {
  try {
    const which = options.which ?? Bun.which;
    const installed = which("gemini");
    if (!installed) throw unavailable();
    if ((options.platform ?? process.platform) !== "win32")
      return [regular(installed, true)];
    if (/\.exe$/i.test(installed)) return [regular(installed)];
    if (
      !["gemini.cmd", "gemini.ps1", "gemini"].includes(
        basename(installed).toLowerCase(),
      )
    )
      throw unavailable();
    regular(installed);
    const root = join(
      dirname(installed),
      "node_modules",
      "@google",
      "gemini-cli",
    );
    const data = packageData(join(root, "package.json"));
    if (
      typeof data !== "object" ||
      data === null ||
      !("name" in data) ||
      data.name !== "@google/gemini-cli" ||
      !("version" in data) ||
      data.version !== "0.65.0" ||
      !("bin" in data) ||
      typeof data.bin !== "object" ||
      data.bin === null ||
      !("gemini" in data.bin) ||
      data.bin.gemini !== "dist/index.js"
    )
      throw unavailable();
    const entry = regular(join(root, "dist", "index.js"));
    const within = relative(realpathSync.native(root), entry);
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw unavailable();
    const node = which("node");
    if (!node || !/\.exe$/i.test(node)) throw unavailable();
    return [regular(node), entry];
  } catch {
    throw unavailable();
  }
}
