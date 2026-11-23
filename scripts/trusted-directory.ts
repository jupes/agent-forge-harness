import { lstatSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";
import { windowsConfigLeafKind } from "./config/transaction-windows";

type DirectoryInfo = {
  dev: bigint;
  ino: bigint;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};
type PathApi = Pick<typeof win32, "dirname" | "relative" | "resolve">;
export interface TrustedDirectoryProbe {
  platform: "win32" | "posix";
  path: PathApi;
  lstat(path: string): DirectoryInfo;
  realpath(path: string): string;
  reparseKind(path: string): "plain" | "reparse" | "unknown";
}

const identity = (info: DirectoryInfo) =>
  `${String(info.dev)}:${String(info.ino)}`;

function defaultProbe(): TrustedDirectoryProbe {
  const platform = process.platform === "win32" ? "win32" : "posix";
  return {
    platform,
    path: platform === "win32" ? win32 : posix,
    lstat: (path) => lstatSync(path, { bigint: true }),
    realpath: (path) => realpathSync.native(path),
    reparseKind: windowsConfigLeafKind,
  };
}

/** Resolve an existing directory spelling through checked filesystem identities. */
export function canonicalTrustedDirectory(
  path: string,
  probe: TrustedDirectoryProbe = defaultProbe(),
): string {
  const requested = probe.path.resolve(path);
  let existing = requested;
  for (;;) {
    try {
      probe.lstat(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = probe.path.dirname(existing);
      if (parent === existing)
        throw new Error("The trusted directory is unavailable.");
      existing = parent;
    }
  }

  const assertPlainDirectory = (target: string) => {
    const info = probe.lstat(target);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (probe.platform === "win32" && probe.reparseKind(target) !== "plain")
    )
      throw new Error("The trusted directory is not a plain directory.");
    return identity(info);
  };
  const components: Array<{ path: string; identity: string }> = [];
  for (let cursor = existing; ; cursor = probe.path.dirname(cursor)) {
    components.push({ path: cursor, identity: assertPlainDirectory(cursor) });
    if (probe.path.dirname(cursor) === cursor) break;
  }

  const physical = probe.realpath(existing),
    physicalIdentity = assertPlainDirectory(physical),
    existingIdentity = components[0]!.identity;
  if (physicalIdentity !== existingIdentity)
    throw new Error("The trusted directory spelling changed identity.");
  const physicalComponents: string[] = [];
  for (let cursor = physical; ; cursor = probe.path.dirname(cursor)) {
    physicalComponents.push(assertPlainDirectory(cursor));
    if (probe.path.dirname(cursor) === cursor) break;
  }
  if (
    physicalComponents.length !== components.length ||
    physicalComponents.some(
      (value, index) => value !== components[index]?.identity,
    )
  )
    throw new Error("The trusted directory component identities changed.");

  const result = probe.path.resolve(
    physical,
    probe.path.relative(existing, requested),
  );
  for (const component of components)
    if (assertPlainDirectory(component.path) !== component.identity)
      throw new Error("The trusted directory changed during validation.");
  const afterPhysical = probe.realpath(existing),
    afterIdentity = assertPlainDirectory(afterPhysical),
    samePhysicalPath =
      probe.platform === "win32"
        ? afterPhysical.toLowerCase() === physical.toLowerCase()
        : afterPhysical === physical;
  if (!samePhysicalPath || afterIdentity !== existingIdentity)
    throw new Error("The trusted directory changed during validation.");
  return result;
}
