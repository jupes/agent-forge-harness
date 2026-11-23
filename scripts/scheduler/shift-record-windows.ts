import { bunFfi } from "../hearth/acl-windows";

export interface WindowsDeleteAccessApi {
  CreateFileW(
    path: Buffer,
    access: number,
    sharing: number,
    security: null,
    disposition: number,
    flags: number,
    template: null,
  ): number | bigint;
  GetLastError(): number;
  CloseHandle(handle: bigint): number;
}

function loadApi(): WindowsDeleteAccessApi {
  const { dlopen, FFIType } = bunFfi();
  return dlopen("kernel32.dll", {
    CreateFileW: {
      args: [
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
        FFIType.u32,
        FFIType.u32,
        FFIType.ptr,
      ],
      returns: FFIType.u64,
    },
    GetLastError: { args: [], returns: FFIType.u32 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
  }).symbols;
}

/** Existing target only: request DELETE access with all sharing, never delete or set a disposition. */
export function createWindowsDeleteAccessProbe(
  load: () => WindowsDeleteAccessApi = loadApi,
): (path: string) => number | null {
  let api: WindowsDeleteAccessApi | undefined;
  return (path) => {
    let held: bigint | undefined,
      result: number | null = null;
    try {
      api ??= load();
      const handle = BigInt(
        api.CreateFileW(
          Buffer.from(`${path}\0`, "utf16le"),
          0x10000, // DELETE access also covers rename; this call performs neither.
          0x7, // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE.
          null, // No inheritable security attributes.
          3, // OPEN_EXISTING: never create a replacement target.
          0x00200080, // OPEN_REPARSE_POINT | NORMAL: never follow a new link.
          null,
        ),
      );
      if (handle === 0xffffffffffffffffn) {
        const error = api.GetLastError();
        if (Number.isSafeInteger(error) && error > 0) result = error;
      } else if (handle !== 0n) {
        held = handle;
        result = 0;
      }
    } catch {
      result = null;
    } finally {
      if (held !== undefined && api) {
        try {
          if (api.CloseHandle(held) === 0) result = null;
        } catch {
          result = null;
        }
      }
    }
    return result;
  };
}

/** Lazy lookup keeps ordinary one-shot writes and Node imports free of native calls. */
export const windowsDeleteAccessError = createWindowsDeleteAccessProbe();
