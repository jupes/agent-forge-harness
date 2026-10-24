import { expect, test } from "bun:test";
import {
  createWindowsDeleteAccessProbe,
  type WindowsDeleteAccessApi,
} from "./shift-record-windows";

test("the native probe is lazy and requests existing DELETE access with all sharing and no inherited handle", () => {
  let loads = 0;
  const calls: unknown[][] = [],
    closed: bigint[] = [];
  const api: WindowsDeleteAccessApi = {
    CreateFileW(...args) {
      calls.push(args);
      return 123n;
    },
    GetLastError() {
      throw Error("A successful handle has no error to classify.");
    },
    CloseHandle(handle) {
      closed.push(handle);
      return 1;
    },
  };
  const probe = createWindowsDeleteAccessProbe(() => {
    loads++;
    return api;
  });
  expect(loads).toBe(0);
  expect(probe("C:\\owned fixture\\original.json")).toBe(0);
  expect(loads).toBe(1);
  expect(calls).toEqual([
    [
      Buffer.from("C:\\owned fixture\\original.json\0", "utf16le"),
      0x10000,
      0x7,
      null,
      3,
      0x00200080,
      null,
    ],
  ]);
  expect(closed).toEqual([123n]);
  expect(probe("C:\\owned fixture\\original.json")).toBe(0);
  expect(loads).toBe(1);
  expect(closed).toEqual([123n, 123n]);
});

for (const code of [32, 5, 0, Number.NaN])
  test(`a failed native open reports only its actual code ${code}, never an inferred sharing conflict`, () => {
    let closed = 0,
      errors = 0;
    const probe = createWindowsDeleteAccessProbe(() => ({
      CreateFileW: () => 0xffffffffffffffffn,
      GetLastError() {
        errors++;
        return code;
      },
      CloseHandle() {
        closed++;
        return 1;
      },
    }));
    expect(probe("C:\\fixture\\existing.json")).toBe(
      Number.isSafeInteger(code) && code > 0 ? code : null,
    );
    expect(errors).toBe(1);
    expect(closed).toBe(0);
  });

for (const close of ["refused", "threw"] as const)
  test(`an uncertain native handle close (${close}) remains unknown`, () => {
    let closes = 0;
    const probe = createWindowsDeleteAccessProbe(() => ({
      CreateFileW: () => 55n,
      GetLastError: () => 32,
      CloseHandle() {
        closes++;
        if (close === "threw") throw Error("Close status unavailable");
        return 0;
      },
    }));
    expect(probe("C:\\fixture\\existing.json")).toBeNull();
    expect(closes).toBe(1);
  });

test("an unavailable runtime or failed native call is unknown and never a sharing authorization", () => {
  const unavailable = createWindowsDeleteAccessProbe(() => {
    throw Error("No native runtime");
  });
  expect(unavailable("C:\\fixture\\existing.json")).toBeNull();
  const failed = createWindowsDeleteAccessProbe(() => ({
    CreateFileW() {
      throw Error("Native call failed");
    },
    GetLastError: () => 32,
    CloseHandle() {
      throw Error("No handle was opened");
    },
  }));
  expect(failed("C:\\fixture\\existing.json")).toBeNull();
  const noError = createWindowsDeleteAccessProbe(() => ({
    CreateFileW: () => 0xffffffffffffffffn,
    GetLastError() {
      throw Error("Native error unavailable");
    },
    CloseHandle() {
      throw Error("No handle was opened");
    },
  }));
  expect(noError("C:\\fixture\\existing.json")).toBeNull();
});
