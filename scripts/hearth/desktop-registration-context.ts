import { isAbsolute, resolve } from "node:path";

export interface DesktopRegistrationContext {
  readonly version: 1;
  readonly root: string;
  readonly home: string;
  readonly command: string;
  readonly args: readonly string[];
}
export interface DesktopRegistrationOptions {
  root: string;
  home: string;
  hearthCommand?: readonly string[];
  nativeApp?: string;
}
export function createDesktopRegistrationContext(
  options: DesktopRegistrationOptions,
): DesktopRegistrationContext | null {
  const absolute = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    !/[\0\r\n]/.test(value) &&
    isAbsolute(value);
  const { root, home, nativeApp, hearthCommand } = options;
  if (
    !absolute(root) ||
    !absolute(home) ||
    !absolute(nativeApp) ||
    !Array.isArray(hearthCommand) ||
    hearthCommand.length !== 3
  )
    return null;
  const [command, flag, picker] = hearthCommand;
  if (
    !absolute(command) ||
    flag !== "--native-project-picker" ||
    !absolute(picker) ||
    resolve(picker) !== resolve(nativeApp)
  )
    return null;
  const selectedRoot = resolve(root),
    selectedHome = resolve(home);
  const value: DesktopRegistrationContext = {
    version: 1,
    root: selectedRoot,
    home: selectedHome,
    command: resolve(command),
    args: Object.freeze([
      "--mcp-stdio",
      "--root",
      selectedRoot,
      "--home",
      selectedHome,
    ]),
  };
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= 2048
    ? Object.freeze(value)
    : null;
}
