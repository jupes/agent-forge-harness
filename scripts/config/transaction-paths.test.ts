import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../test-scratch";
import {
  configAddress,
  createConfigParentTransition,
  verifyConfigParentTransition,
} from "./transaction-paths";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

test("own parent creation authorizes only its exact new directories, even when a retarget preserves the innermost identity", () => {
  const root = scratch.make("config-parent-transition-");
  const outer = join(root, "new-outer");
  const inner = join(outer, "new-inner");
  const file = join(inner, "config.toml");
  const expected = configAddress(file);
  const transition = createConfigParentTransition(expected, expected.anchor);
  expect(transition.created.map((anchor) => anchor.path)).toEqual([
    realpathSync.native(outer),
    realpathSync.native(inner),
  ]);
  expect(() =>
    verifyConfigParentTransition(expected, transition),
  ).not.toThrow();
  const oldInner = lstatSync(inner, { bigint: true });
  const retained = join(root, "retained-outer");
  renameSync(outer, retained);
  mkdirSync(outer);
  renameSync(join(retained, "new-inner"), inner);
  const sameInner = lstatSync(inner, { bigint: true });
  expect([sameInner.dev, sameInner.ino]).toEqual([oldInner.dev, oldInner.ino]);
  expect(() => verifyConfigParentTransition(expected, transition)).toThrow(
    "changed",
  );
  expect(existsSync(file)).toBe(false);
});

test("a parent created outside the captured transition is not silently adopted", () => {
  const root = scratch.make("config-parent-transition-");
  const parent = join(root, "new-parent");
  const expected = configAddress(join(parent, "config.toml"));
  mkdirSync(parent);
  expect(() => createConfigParentTransition(expected, expected.anchor)).toThrow(
    "changed",
  );
  expect(existsSync(join(parent, "config.toml"))).toBe(false);
});
