import { execFile } from "node:child_process";
import { join } from "node:path";
import {
  captureOwnTracker,
  type OwnTrackerDescriptor,
  sameOwnTracker,
} from "./complete-tracker-descriptor";
import {
  COMPLETE_TRACKER_BYTES,
  type CompleteTracker,
  parseCompleteTracker,
} from "./complete-tracker-source";

export type TrackerChild = (
  descriptor: OwnTrackerDescriptor,
) => Promise<{ exited: boolean; status: number | null; stdout: string }>;
export type CompleteTrackerReader = () => Promise<CompleteTracker>;

/** A fixed no-child reader: execFile callback runs only after process/stdout close. */
export function trackerChild(
  command: readonly string[] = [
    process.execPath,
    "--no-env-file",
    "--config",
    join(import.meta.dir, "complete-tracker.bunfig.toml"),
    join(import.meta.dir, "complete-tracker-process.ts"),
  ],
): TrackerChild {
  const [program, ...fixedArgs] = command;
  if (!program || command.some((arg) => !arg || arg.includes("\0")))
    throw Error("Tracker reader unavailable.");
  return (descriptor) =>
    new Promise((done) => {
      try {
        // No ambient database selectors, proxy, preload, CLI or credentials settings.
        const env = Object.fromEntries(
          ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"].flatMap(
            (key) =>
              process.env[key] === undefined ? [] : [[key, process.env[key]!]],
          ),
        );
        const child = execFile(
          program,
          [...fixedArgs, descriptor.root, descriptor.fingerprint],
          {
            cwd: descriptor.root,
            env,
            shell: false,
            windowsHide: true,
            timeout: 6000,
            killSignal: "SIGKILL",
            maxBuffer: COMPLETE_TRACKER_BYTES,
            encoding: "utf8",
          },
          (error, stdout) => {
            done({
              exited: child.exitCode !== null || child.signalCode !== null,
              status: error === null ? 0 : null,
              stdout: error === null ? stdout : "",
            });
          },
        );
        child.stdin?.end();
      } catch {
        done({ exited: false, status: null, stdout: "" });
      }
    });
}

/** Capture once; configuration replacement requires deliberate Hearth restart/regrant. */
export function ownTrackerReader(
  root: string,
  run: TrackerChild = trackerChild(),
): CompleteTrackerReader {
  let captured: OwnTrackerDescriptor | null = null;
  try {
    captured = captureOwnTracker(root);
  } catch {
    /* unavailable, never fallback */
  }
  let pending: Promise<CompleteTracker> | null = null;
  const read = async () => {
    if (!captured || !sameOwnTracker(captured)) {
      captured = null;
      throw Error("Complete workspace tracker unavailable.");
    }
    const descriptor = captured;
    const result = await run(descriptor);
    const current = sameOwnTracker(descriptor);
    if (!current) captured = null;
    if (!result.exited || result.status !== 0 || !current)
      throw Error("Complete workspace tracker unavailable.");
    return parseCompleteTracker(result.stdout, {
      database: descriptor.database,
      projectId: descriptor.projectId,
    });
  };
  return () =>
    (pending ??= read()
      .catch(() => {
        throw Error("Complete workspace tracker unavailable.");
      })
      .finally(() => {
        pending = null;
      }));
}
