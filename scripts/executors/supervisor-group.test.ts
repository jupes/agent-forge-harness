import { expect, spyOn, test } from "bun:test";
import { killExitedProcessGroup } from "./supervisor";

test("an absent exited process group never authorizes a positive PID fallback", () => {
  const attempts: number[] = [];
  const kill = spyOn(process, "kill").mockImplementation((pid) => {
    attempts.push(pid);
    throw Error("No owned process group remains");
  });
  try {
    killExitedProcessGroup(12345);
    expect(attempts).toEqual([-12345]);
  } finally {
    kill.mockRestore();
  }
});
