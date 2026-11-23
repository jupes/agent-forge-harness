import { toNamespacedPath } from "node:path";
import { bunFfi } from "../hearth/acl-windows";

export interface WindowsConfigAttributesApi {
  GetFileAttributesW(path: Buffer): number;
}

function loadApi(): WindowsConfigAttributesApi {
  const { dlopen, FFIType } = bunFfi();
  return dlopen("kernel32.dll", {
    GetFileAttributesW: { args: [FFIType.ptr], returns: FFIType.u32 },
  }).symbols;
}

/** Metadata only; no handles, path creation, attribute changes or execution. */
export function createWindowsConfigLeafKind(
  load: () => WindowsConfigAttributesApi = loadApi,
) {
  let api: WindowsConfigAttributesApi | undefined;
  return (file: string): "plain" | "reparse" | "unknown" => {
    try {
      api ??= load();
      const attributes = api.GetFileAttributesW(
        Buffer.from(`${toNamespacedPath(file)}\0`, "utf16le"),
      );
      if (
        !Number.isInteger(attributes) ||
        attributes < 0 ||
        attributes >= 0xffffffff
      )
        return "unknown";
      // https://learn.microsoft.com/en-us/windows/win32/fileio/file-attribute-constants
      return (attributes & 0x400) === 0 ? "plain" : "reparse";
    } catch {
      return "unknown";
    }
  };
}

/** Lazy and Node-import-safe; use only on Windows after a plain-file lstat check. */
export const windowsConfigLeafKind = createWindowsConfigLeafKind();
