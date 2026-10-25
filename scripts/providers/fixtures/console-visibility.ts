import { dlopen, FFIType } from "bun:ffi";

/** Observe the actual native visibility state, not just an attached console handle. */
export function isConsoleWindowVisible(): boolean | null {
  if (process.platform !== "win32") return null;
  const kernel = dlopen("kernel32.dll", {
    GetConsoleWindow: { args: [], returns: FFIType.ptr },
  });
  const user = dlopen("user32.dll", {
    IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.i32 },
  });
  try {
    const window = kernel.symbols.GetConsoleWindow();
    return window !== null && user.symbols.IsWindowVisible(window) !== 0;
  } finally {
    user.close();
    kernel.close();
  }
}
