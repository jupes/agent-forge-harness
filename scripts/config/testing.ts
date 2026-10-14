/**
 * Test support for the config loader: where the machine config file is found.
 */

import { homeVariable } from "../ledger/isolation-probe";

/**
 * Run `body` with this process's `AGENT_FORGE_HOME` and OS home variable
 * pointed at scratch directories, then put both back. `forgeHome` undefined
 * unsets it. Synchronous only: nothing else may run while the variables are
 * moved.
 *
 * Moving the OS home variable is a safety net that holds on Windows only:
 * there `os.homedir()` follows `USERPROFILE` as changed at runtime, so a loader
 * that did not honour `AGENT_FORGE_HOME` reads or writes the scratch home.
 * Under Bun on Linux `os.homedir()` does not follow a runtime change of
 * `HOME`. A test must therefore never rely on the OS home having moved.
 */
export function withProcessHomes<T>(
  forgeHome: string | undefined,
  osHome: string,
  body: () => T,
): T {
  const osVariable = homeVariable();
  const saved = {
    forge: process.env.AGENT_FORGE_HOME,
    os: process.env[osVariable],
  };
  const put = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  put("AGENT_FORGE_HOME", forgeHome);
  put(osVariable, osHome);
  try {
    return body();
  } finally {
    put("AGENT_FORGE_HOME", saved.forge);
    put(osVariable, saved.os);
  }
}
