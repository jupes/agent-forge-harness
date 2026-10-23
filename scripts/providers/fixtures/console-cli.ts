/** Inert native console fixture: no provider, account, credential file or network. */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { writeFileSync } from "node:fs";
import { windowsConsoleCommand } from "../native-console";

const file = process.env["CONSOLE_FIXTURE_RECORD"];
if (!file) throw Error("Explicit console fixture record required");
const args = process.argv.slice(2);
if (args[0] === "child") await new Promise(() => {});
else if (args[0] === "exit-with-child") {
  // Bypass Bun's own child-exit cleanup so only the enclosing native job can end this helper.
  const kernel = dlopen("kernel32.dll", {
    CreateProcessW: {
      args: [
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.i32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
        FFIType.ptr,
      ],
      returns: FFIType.i32,
    },
  });
  const startup = new Uint8Array(104),
    info = new Uint8Array(24),
    app = Buffer.from(`${process.execPath}\0`, "utf16le"),
    command = windowsConsoleCommand([
      process.execPath,
      import.meta.path,
      "child",
    ]);
  new DataView(startup.buffer).setUint32(0, 104, true);
  if (
    !kernel.symbols.CreateProcessW(
      ptr(app),
      ptr(command),
      null,
      null,
      0,
      0x08000000,
      null,
      null,
      ptr(startup),
      ptr(info),
    )
  )
    throw Error("Synthetic helper failed to start");
  writeFileSync(
    file,
    JSON.stringify({ childPid: new DataView(info.buffer).getUint32(16, true) }),
  );
  process.exit(0);
} else if (args[0] === "hang-tree") {
  const child = Bun.spawn([process.execPath, import.meta.path, "child"], {
    env: { CONSOLE_FIXTURE_RECORD: file },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  writeFileSync(file, JSON.stringify({ childPid: child.pid }));
  await new Promise(() => {});
} else {
  writeFileSync(
    file,
    JSON.stringify({
      args,
      marker: process.env["NATIVE_FIXTURE_SECRET"] ?? null,
      cwd: process.cwd(),
    }),
  );
  console.log("terminal-fixture-output-never-captured");
}
