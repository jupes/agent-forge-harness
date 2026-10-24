/** Config-only parent-address and own-creation checks; callers hold the write mutex. */
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { configChanged, invalidConfigPath } from "./transaction-error";

export type ConfigFileIdentity = Readonly<{ dev: string; ino: string }>;
export type ConfigParentAnchor = Readonly<{
  path: string;
  identity: ConfigFileIdentity;
}>;
export type ConfigAddress = Readonly<{
  requested: string;
  file: string;
  anchor: ConfigParentAnchor;
}>;
export type ConfigParentTransition = Readonly<{
  before: ConfigParentAnchor;
  after: ConfigParentAnchor;
  created: readonly ConfigParentAnchor[];
}>;

export const configFileIdentity = (info: {
  dev: bigint;
  ino: bigint;
}): ConfigFileIdentity =>
  Object.freeze({ dev: String(info.dev), ino: String(info.ino) });
const same = (a: unknown, b: unknown) => Bun.deepEquals(a, b, true);

/** Resolve a rename address through its existing parent, never through its leaf. */
export function configAddress(requested: string): ConfigAddress {
  const full = resolve(requested);
  const missing: string[] = [];
  let parent = dirname(full);
  for (;;) {
    try {
      const canonical = realpathSync.native(parent);
      const info = lstatSync(canonical, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink())
        invalidConfigPath("A configuration parent is not a plain directory.");
      return Object.freeze({
        requested: full,
        file: join(canonical, ...missing, basename(full)),
        anchor: Object.freeze({
          path: canonical,
          identity: configFileIdentity(info),
        }),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const next = dirname(parent);
      if (next === parent)
        invalidConfigPath("A configuration parent could not be resolved.");
      missing.unshift(basename(parent));
      parent = next;
    }
  }
}

function verifyAnchor(anchor: ConfigParentAnchor): void {
  const info = lstatSync(anchor.path, { bigint: true });
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    realpathSync.native(anchor.path) !== anchor.path ||
    !same(configFileIdentity(info), anchor.identity)
  )
    configChanged();
}

export function checkedConfigAddress(expected: ConfigAddress): ConfigAddress {
  const current = configAddress(expected.requested);
  verifyAnchor(expected.anchor);
  if (current.file !== expected.file) configChanged();
  return current;
}

/** Internal mutation: create only selected missing parents while the config mutex is held. */
export function createConfigParentTransition(
  expected: ConfigAddress,
  before: ConfigParentAnchor,
): ConfigParentTransition {
  const current = checkedConfigAddress(expected);
  if (!same(current.anchor, before)) configChanged();
  const paths: string[] = [];
  let path = dirname(current.file);
  while (path !== before.path) {
    paths.unshift(path);
    const next = dirname(path);
    if (next === path) configChanged();
    path = next;
  }
  const created: ConfigParentAnchor[] = [];
  for (const directory of paths) {
    checkedConfigAddress(expected);
    verifyAnchor(before);
    for (const anchor of created) verifyAnchor(anchor);
    // EEXIST is not proof that this operation created the reviewed parent.
    mkdirSync(directory);
    const info = lstatSync(directory, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) configChanged();
    const anchor = Object.freeze({
      path: directory,
      identity: configFileIdentity(info),
    });
    verifyAnchor(anchor);
    created.push(anchor);
  }
  const after = checkedConfigAddress(expected).anchor;
  if (after.path !== dirname(expected.file)) configChanged();
  const transition = Object.freeze({
    before,
    after,
    created: Object.freeze(created),
  });
  verifyConfigParentTransition(expected, transition);
  return transition;
}

/** Own creation authorizes only these exact directory identities, never a blanket parent change. */
export function verifyConfigParentTransition(
  expected: ConfigAddress,
  transition: ConfigParentTransition,
): void {
  const current = checkedConfigAddress(expected);
  verifyAnchor(transition.before);
  for (const anchor of transition.created) verifyAnchor(anchor);
  if (!same(current.anchor, transition.after)) configChanged();
}
