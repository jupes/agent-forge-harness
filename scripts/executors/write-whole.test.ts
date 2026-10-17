import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { scratchDirs } from "../test-scratch";
import { writeWhole } from "./fixtures/write-whole";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

describe("writeWhole (the stand-in CLI's dump and attach files)", () => {
  test("writes the text to the path and leaves no other file beside it", () => {
    const dir = scratch.make("write whole ");
    const path = join(dir, "dump.json");
    writeWhole(path, '{"pid":1}');
    expect(readFileSync(path, "utf8")).toBe('{"pid":1}');
    expect(readdirSync(dir)).toEqual(["dump.json"]);
  });

  // The child is killed at its timeout (`taskkill /F`): a write it had begun
  // stops after the file was created and before the text was in it.
  test("a write cut short after its file was created leaves no file at the path", () => {
    const dir = scratch.make("write whole ");
    const path = join(dir, "dump.json");
    const cutShort = {
      writeFileSync(file: string) {
        writeFileSync(file, "");
        throw new Error("killed mid-write");
      },
      renameSync,
    };
    expect(() => writeWhole(path, '{"pid":1}', cutShort)).toThrow(
      "killed mid-write",
    );
    expect(existsSync(path)).toBe(false);
  });

  test("a path written before is replaced whole", () => {
    const dir = scratch.make("write whole ");
    const path = join(dir, "dump.json");
    writeWhole(path, '{"pid":1}');
    writeWhole(path, '{"pid":2}');
    expect(readFileSync(path, "utf8")).toBe('{"pid":2}');
    expect(readdirSync(dir)).toEqual(["dump.json"]);
  });
});
