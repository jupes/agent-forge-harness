import { join, resolve } from "node:path";

/** Keep the Git fixture's temporary config separate from the server's OS home. */
export function desktopWorktreeHomeLayout(
  fixtureRoot: string,
  serverOsHome: string,
) {
  const gitHome = join(fixtureRoot, "empty-home");
  const normalize = (value: string) => {
    const absolute = resolve(value);
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  };
  if (normalize(gitHome) === normalize(serverOsHome))
    throw new Error(
      "The Git fixture home must differ from the server OS home.",
    );
  return { gitHome, serverOsHome };
}
