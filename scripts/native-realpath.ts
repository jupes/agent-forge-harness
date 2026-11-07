import {
  type BigIntStats,
  lstatSync,
  readlinkSync,
  realpathSync,
} from "node:fs";

export interface NativePhysicalPathDeps {
  platform?: "win32" | "posix";
  cwd?: () => string;
  lstat?: (
    path: string,
  ) => Pick<BigIntStats, "dev" | "ino" | "isDirectory" | "isSymbolicLink">;
  readlink?: (path: string) => string;
  realpath?: (path: string) => string;
}
type PhysicalStat = {
  dev: bigint;
  ino: bigint;
  directory: boolean;
  link: boolean;
};
const invalid = (): never => {
  throw Error("Native physical path could not be verified");
};
const representable = (value: string) => !/[\0\p{Cs}]/u.test(value);
const same = (a: PhysicalStat, b: PhysicalStat) =>
  a.dev === b.dev && a.ino === b.ino;

/** Host-only physical authority. Native canonical spelling is never its own proof. */
export function nativePhysicalPath(
  path: string,
  deps: NativePhysicalPathDeps = {},
): string {
  const native = deps.realpath ?? realpathSync.native;
  if (
    (deps.platform ?? (process.platform === "win32" ? "win32" : "posix")) ===
    "win32"
  )
    return native(path);
  if (typeof path !== "string" || !path || !representable(path))
    return invalid();
  const lstat =
    deps.lstat ?? ((name: string) => lstatSync(name, { bigint: true }));
  const readlink =
    deps.readlink ??
    ((name: string) =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        readlinkSync(name, { encoding: "buffer" }),
      ));
  const stat = (name: string): PhysicalStat => {
    const value = lstat(name);
    if (
      !value ||
      typeof value.dev !== "bigint" ||
      typeof value.ino !== "bigint" ||
      value.dev < 0n ||
      value.ino <= 0n ||
      typeof value.isDirectory !== "function" ||
      typeof value.isSymbolicLink !== "function"
    )
      return invalid();
    const directory = value.isDirectory(),
      link = value.isSymbolicLink();
    if (
      typeof directory !== "boolean" ||
      typeof link !== "boolean" ||
      (directory && link)
    )
      return invalid();
    return { dev: value.dev, ino: value.ino, directory, link };
  };
  let steps = 0,
    links = 0;
  const root = stat("/"),
    components: string[] = [];
  if (!root.directory || root.link) return invalid();
  let last = root;
  const spelling = () => "/" + components.join("/");
  const walk = (input: string) => {
    if (!input || !representable(input)) return invalid();
    const pending = input.split("/");
    if (pending.length + steps > 4096) return invalid();
    if (input.startsWith("/")) {
      components.length = 0;
      last = root;
    }
    while (pending.length) {
      if (++steps > 4096) return invalid();
      const current = stat(spelling());
      if (!same(current, last) || !current.directory || current.link)
        return invalid();
      const part = pending.shift();
      if (part === undefined) return invalid();
      if (part === "" || part === ".") {
        last = current;
        continue;
      }
      if (part === "..") {
        components.pop();
        last = stat(spelling());
        if (!last.directory || last.link) return invalid();
        continue;
      }
      const name = spelling().replace(/\/$/, "") + "/" + part;
      const found = stat(name);
      if (found.link) {
        if (++links > 40) return invalid();
        const target = readlink(name);
        if (
          typeof target !== "string" ||
          !target ||
          !representable(target) ||
          !same(found, stat(name))
        )
          return invalid();
        const expanded = target.split("/");
        if (steps + expanded.length + pending.length > 4096) return invalid();
        if (target.startsWith("/")) {
          components.length = 0;
          last = root;
        } else last = current;
        pending.unshift(...expanded);
      } else {
        components.push(part);
        last = found;
      }
    }
    const checked = stat(spelling());
    if (checked.link || !same(checked, last)) return invalid();
    last = checked;
  };
  if (!path.startsWith("/")) {
    const cwd = (deps.cwd ?? (() => process.cwd()))();
    if (typeof cwd !== "string" || !cwd.startsWith("/")) return invalid();
    walk(cwd);
    const actual = stat(".");
    if (!actual.directory || actual.link || !same(last, actual))
      return invalid();
  }
  walk(path);
  const physical = spelling();
  const original = last;
  try {
    const canonical = native(physical);
    if (canonical === physical) return physical;
    if (typeof canonical === "string" && canonical.startsWith("/")) {
      walk(canonical);
      if (canonical === spelling() && same(original, last)) return canonical;
    }
  } catch {
    /* Failed or over-budget optional spelling cannot replace the physical proof. */
  }
  return physical;
}
