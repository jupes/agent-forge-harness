import { ptr } from "bun:ffi";
import { expect, test } from "bun:test";
import { windowsJobSettlementApi } from "./tree-guard";

function nativeFixture(error = 87) {
  const calls: string[] = [];
  const unused = () => {
    throw Error("Unexpected native fixture call");
  };
  const native: Parameters<typeof windowsJobSettlementApi>[0] = {
    CreateJobObjectW: unused,
    SetInformationJobObject: unused,
    AssignProcessToJobObject: unused,
    TerminateJobObject: unused,
    QueryInformationJobObject: unused,
    IsProcessInJob: unused,
    GetProcessTimes: unused,
    WaitForSingleObject: unused,
    CloseHandle: unused,
    OpenProcess() {
      calls.push("open");
      return null;
    },
    GetLastError() {
      calls.push("last-error");
      return error;
    },
  };
  return { native, calls };
}

test("native member open refusal emits only fixed categories", () => {
  const cases = [
    [87, "capture-member-open-invalid-parameter"],
    [5, "capture-member-open-access-denied"],
    [0, "capture-member-open-other-error"],
  ] as const;
  for (const [code, phase] of cases) {
    const f = nativeFixture(code);
    const api = windowsJobSettlementApi(f.native, (observed) => {
      f.calls.push(observed);
    });
    expect(api.openProcess(901)).toBeNull();
    expect(f.calls).toEqual(["open", "last-error", phase]);
  }
});

test("native member open success and default refusal never read last error", () => {
  const f = nativeFixture();
  expect(windowsJobSettlementApi(f.native).openProcess(901)).toBeNull();
  expect(f.calls).toEqual(["open"]);
  f.calls.length = 0;
  const memory = new Uint8Array(1);
  const handle = ptr(memory);
  f.native.OpenProcess = () => {
    f.calls.push("open");
    return handle;
  };
  const api = windowsJobSettlementApi(f.native, () => {
    throw Error("Successful open must not notify");
  });
  expect(api.openProcess(901) === handle).toBe(true);
  expect(f.calls).toEqual(["open"]);
});

test("native member open diagnostics cannot change null refusal", () => {
  for (const boundary of ["read", "getter", "observer"]) {
    const f = nativeFixture();
    if (boundary === "read")
      f.native.GetLastError = () => {
        f.calls.push("last-error");
        throw Error("Private diagnostic read failure");
      };
    if (boundary === "getter")
      Object.defineProperty(f.native, "GetLastError", {
        get() {
          f.calls.push("last-error");
          throw Error("Private diagnostic getter failure");
        },
      });
    const api = windowsJobSettlementApi(f.native, () => {
      f.calls.push("observer");
      throw Error("Private observer failure");
    });
    expect(api.openProcess(901)).toBeNull();
    expect(f.calls).toEqual([
      "open",
      "last-error",
      ...(boundary === "observer" ? ["observer"] : []),
    ]);
  }
});
