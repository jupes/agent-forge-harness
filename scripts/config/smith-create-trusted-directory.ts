import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { windowsConfigLeafKind } from "./transaction-windows";

type Identity = Readonly<{ dev: string; ino: string }>;
type Component = Readonly<{ path: string; identity: Identity }>;

const identity = (info: { dev: bigint; ino: bigint }): Identity => ({
  dev: String(info.dev),
  ino: String(info.ino),
});
const sameIdentity = (a: Identity, b: Identity) =>
  a.dev === b.dev && a.ino === b.ino;
const samePath = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

function assertPlainDirectory(path: string): Identity {
  const info = lstatSync(path, { bigint: true });
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.platform === "win32" && windowsConfigLeafKind(path) !== "plain")
  )
    throw new Error("The trusted Smith create directory is not canonical.");
  return identity(info);
}

/** Resolve trusted directory spelling aliases without following linked parents. */
export function canonicalSmithCreateDirectory(path: string): string {
  const requested = resolve(path);
  let existing = requested;
  for (;;) {
    try {
      lstatSync(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing)
        throw new Error("The trusted Smith create directory is unavailable.");
      existing = parent;
    }
  }

  const components: Component[] = [];
  for (let cursor = existing; ; cursor = dirname(cursor)) {
    components.push({ path: cursor, identity: assertPlainDirectory(cursor) });
    if (dirname(cursor) === cursor) break;
  }

  const physical = realpathSync.native(existing),
    physicalIdentity = assertPlainDirectory(physical),
    existingIdentity = components[0]!.identity;
  if (!sameIdentity(physicalIdentity, existingIdentity))
    throw new Error("The trusted Smith create directory is not canonical.");

  const result = resolve(physical, relative(existing, requested));
  for (const component of components)
    if (!sameIdentity(assertPlainDirectory(component.path), component.identity))
      throw new Error("The trusted Smith create directory changed.");
  const afterPhysical = realpathSync.native(existing),
    afterIdentity = assertPlainDirectory(afterPhysical);
  if (
    !samePath(afterPhysical, physical) ||
    !sameIdentity(afterIdentity, existingIdentity)
  )
    throw new Error("The trusted Smith create directory changed.");
  return result;
}
