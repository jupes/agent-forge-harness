/**
 * Layered config for smiths, benches, the executor env allowlist and the
 * shift's defaults.
 *
 * Precedence, low to high: builtin < the machine file (`config.toml` in the
 * Agent Forge home: `AGENT_FORGE_HOME`, else `~/.agent-forge`) <
 * <harness>/agent-forge.toml < env. Every effective value carries its
 * provenance. Security keys (`execution.env.pass`) are never inherited from the
 * user file once a workspace file exists (decision #17), whichever home it was
 * read from.
 *
 * Parsing uses the runtime's `Bun.TOML` — no dependency.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { BENCH_NAMES, type BenchName, type Smith } from "../../types/hearth";
import { agentForgeHome } from "../agent-forge-home";
import { validateSmith } from "../hearth/validate";
import {
  type BenchEntry,
  BUILTIN_BENCHES,
  BUILTIN_DEFAULT_CREW,
  BUILTIN_SHIFT,
  BUILTIN_SMITHS,
  SHIFT_LIMITS,
  SHIFT_MAX_USD,
} from "./defaults";

export interface Provenance {
  value: unknown;
  /** "builtin", "env", or the absolute path of the file the value came from. */
  source: string;
}

/**
 * `[shift]`: what `forge:shift run` takes for each flag it was not given, and
 * the host threshold. Names as `ShiftOptions` (scripts/scheduler/shift.ts).
 */
export interface ShiftConfig {
  /** How many beads run at once (`concurrency`). */
  concurrency: number;
  /** How long a shift lasts, in ms (`for`: `90s`, `30m`, `2h`). */
  forMs: number;
  /** How many beads a shift admits in all (`max_beads`). */
  maxBeads: number;
  /** The spend, in US dollars, past which a shift admits no more (`max_usd`). */
  maxUsd: number;
  /** Runs after a failed one before the bead is halted (`repairs`). */
  repairs: number;
  /** At or above this share of CPU or of memory in use, the host is too busy to admit more (`throttle`). */
  throttle: number;
}

export interface ForgeConfig {
  workflow: { defaultCrew: string };
  smiths: Record<string, Smith>;
  benches: Record<BenchName, BenchEntry[]>;
  execution: { envPass: string[] };
  shift: ShiftConfig;
}

/** Each `[shift]` key and the `ShiftConfig` field it sets. */
const SHIFT_FIELDS = {
  concurrency: "concurrency",
  for: "forMs",
  max_beads: "maxBeads",
  max_usd: "maxUsd",
  repairs: "repairs",
  throttle: "throttle",
} as const satisfies Record<keyof typeof BUILTIN_SHIFT, keyof ShiftConfig>;

export type ShiftKey = keyof typeof SHIFT_FIELDS;

/** The keys `[shift]` takes, in the order they are listed. */
export const SHIFT_KEYS = Object.keys(SHIFT_FIELDS) as ShiftKey[];

const DURATION = /^([1-9]\d{0,5})(s|m|h)$/;
const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000 } as const;

/** `90s`, `30m`, `2h` in ms; null for anything else. `forge:shift run --for` and `[shift] for` take these. */
export function parseDuration(text: string): number | null {
  const match = DURATION.exec(text);
  if (match === null) return null;
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/** Why `value` is not a whole number from `low` to `high`, or null. */
export function wholeNumberError(
  value: unknown,
  [low, high]: readonly [number, number],
): string | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= low &&
    value <= high
    ? null
    : `expected a whole number from ${low} to ${high}`;
}

/** Why `value` is not a shift's spend cap, or null. */
export function maxUsdError(value: unknown): string | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= SHIFT_MAX_USD
    ? null
    : `expected dollars above 0, at most ${SHIFT_MAX_USD}`;
}

/** The value a `[shift]` key holds, as the shift takes it, or why it is not one. */
function shiftValue(
  key: ShiftKey,
  raw: unknown,
): { ok: true; value: number } | { ok: false; error: string } {
  const checked = (error: string | null) =>
    error === null
      ? { ok: true as const, value: raw as number }
      : { ok: false as const, error };
  switch (key) {
    case "for": {
      const ms = typeof raw === "string" ? parseDuration(raw) : null;
      if (ms === null)
        return {
          ok: false,
          error: "expected a duration such as 90s, 30m or 2h",
        };
      return wholeNumberError(ms, SHIFT_LIMITS.forMs) === null
        ? { ok: true, value: ms }
        : {
            ok: false,
            error: `expected a duration of at most ${SHIFT_LIMITS.forMs[1] / UNIT_MS.h}h`,
          };
    }
    case "max_usd":
      return checked(maxUsdError(raw));
    case "throttle":
      return checked(
        typeof raw === "number" && raw > 0 && raw <= 1
          ? null
          : "expected a share above 0, at most 1 (0.85 is 85%)",
      );
    default:
      return checked(wholeNumberError(raw, SHIFT_LIMITS[SHIFT_FIELDS[key]]));
  }
}

/** The values `table` (a `[shift]`, every key optional) sets; a bad key fails naming `file`. */
function readShift(
  file: string,
  table: Readonly<Record<string, unknown>>,
  onValue: (key: ShiftKey, raw: unknown) => void = () => undefined,
): Partial<ShiftConfig> {
  const shift: Partial<ShiftConfig> = {};
  for (const [key, raw] of Object.entries(table)) {
    // A key of its own: `constructor` is on every object.
    if (!Object.hasOwn(SHIFT_FIELDS, key))
      fail(
        file,
        `shift.${key}`,
        `unknown key (expected ${SHIFT_KEYS.join(" | ")})`,
      );
    const read = shiftValue(key as ShiftKey, raw);
    if (!read.ok) fail(file, `shift.${key}`, read.error);
    shift[SHIFT_FIELDS[key as ShiftKey]] = read.value;
    onValue(key as ShiftKey, raw);
  }
  return shift;
}

/**
 * `[shift]` from the builtins alone, checked as a file's `[shift]` is. Every
 * key of `ShiftConfig` has a builtin (`SHIFT_FIELDS` maps each key of
 * `BUILTIN_SHIFT`), so the read sets every field.
 */
export const BUILTIN_SHIFT_CONFIG: Readonly<ShiftConfig> = readShift(
  "builtin",
  BUILTIN_SHIFT,
) as ShiftConfig;

export interface LoadedConfig {
  config: ForgeConfig;
  provenance: Record<string, Provenance>;
  files: string[];
}

export interface LoadOptions {
  harnessRoot: string;
  /**
   * Stands in for the OS home: the machine file is then
   * `<home>/.agent-forge/config.toml`, whatever `AGENT_FORGE_HOME` says.
   * Absent, it is `config.toml` in this process's Agent Forge home.
   */
  home?: string | undefined;
  /**
   * The env layer (`AGENT_FORGE_SMITH`); defaults to this process's. It does
   * not move the machine file: `forge:exec` passes the environment it hands
   * its child here, and the file is the launcher's own, as the OS home was.
   */
  env?: Record<string, string | undefined> | undefined;
  /**
   * Text that stands in for a layer's file, as if the file held it (and so
   * existed). `forge:config set` checks an edit this way before writing it.
   */
  contents?: { user?: string; workspace?: string } | undefined;
}

type Table = Record<string, unknown>;

/**
 * The machine (user) config file: `<home>/.agent-forge/config.toml` for an
 * explicit `home`, else `config.toml` in the Agent Forge home of this process
 * (`scripts/agent-forge-home.ts`), where its ledger and hearth lock live too.
 */
export function machineConfigFile(options: Pick<LoadOptions, "home">): string {
  return options.home !== undefined
    ? join(options.home, ".agent-forge", "config.toml")
    : join(agentForgeHome(), "config.toml");
}

function isTable(v: unknown): v is Table {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(file: string, key: string, message: string): never {
  throw new Error(`${file}: ${key}: ${message}`);
}

/** A leading byte-order mark, which `Bun.TOML` reads as an empty document. */
const BOM = "\uFEFF";

/**
 * A config file's text. UTF-16 (what Windows PowerShell 5.1 writes by default)
 * is refused with a message: read as UTF-8 it is not TOML, and a lenient
 * parse could take it for an empty file that still counts as present.
 */
export function readConfigText(file: string): string {
  const bytes = readFileSync(file);
  const [first, second] = bytes;
  if (
    (first === 0xff && second === 0xfe) ||
    (first === 0xfe && second === 0xff)
  )
    throw new Error(`${file}: is saved as UTF-16; save it as UTF-8`);
  return bytes.toString("utf8");
}

function readToml(file: string, content?: string): Table {
  const text = content ?? readConfigText(file);
  try {
    const parsed = Bun.TOML.parse(
      text.startsWith(BOM) ? text.slice(BOM.length) : text,
    );
    return isTable(parsed) ? parsed : {};
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: cannot parse TOML: ${reason}`);
  }
}

function parseBench(file: string, name: string, raw: unknown): BenchEntry[] {
  const key = `benches.${name}`;
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(file, key, 'expected a non-empty array of "smith:weight" strings');
  }
  return raw.map((item) => {
    const [smith, weightText, ...rest] = String(item).split(":");
    const weight = Number(weightText);
    if (!smith || rest.length > 0 || !Number.isFinite(weight) || weight <= 0) {
      fail(
        file,
        key,
        `bad weight in "${String(item)}" (expected smith:weight, weight > 0)`,
      );
    }
    return { smith, weight };
  });
}

export function loadConfig(options: LoadOptions): LoadedConfig {
  const env = options.env ?? process.env;
  const userFile = machineConfigFile(options);
  const workspaceFile = join(options.harnessRoot, "agent-forge.toml");
  const given = options.contents ?? {};
  const hasWorkspace =
    given.workspace !== undefined || existsSync(workspaceFile);

  const smiths: Record<string, Smith> = {};
  const provenance: Record<string, Provenance> = {};
  const files: string[] = [];
  let defaultCrew = BUILTIN_DEFAULT_CREW;
  const benches = {} as Record<BenchName, BenchEntry[]>;
  let envPass: string[] = [];

  const set = (key: string, value: unknown, source: string) => {
    provenance[key] = { value, source };
  };

  for (const [name, smith] of Object.entries(BUILTIN_SMITHS)) {
    smiths[name] = { ...smith, tags: [...smith.tags] };
    for (const [field, value] of Object.entries(smith)) {
      if (field !== "name") set(`smiths.${name}.${field}`, value, "builtin");
    }
  }
  set("workflow.default_crew", defaultCrew, "builtin");
  for (const bench of BENCH_NAMES) {
    benches[bench] = BUILTIN_BENCHES[bench].map((e) => ({ ...e }));
    set(`benches.${bench}`, benches[bench], "builtin");
  }
  set("execution.env.pass", envPass, "builtin");
  let shift: ShiftConfig = { ...BUILTIN_SHIFT_CONFIG };
  for (const key of SHIFT_KEYS)
    set(`shift.${key}`, BUILTIN_SHIFT[key], "builtin");

  const layers: Array<{
    file: string;
    secure: boolean;
    content: string | undefined;
  }> = [
    { file: userFile, secure: !hasWorkspace, content: given.user },
    { file: workspaceFile, secure: true, content: given.workspace },
  ];
  for (const { file, secure, content } of layers) {
    if (content === undefined && !existsSync(file)) continue;
    files.push(file);
    const doc = readToml(file, content);

    const workflow = doc.workflow;
    if (isTable(workflow) && typeof workflow.default_crew === "string") {
      defaultCrew = workflow.default_crew;
      set("workflow.default_crew", defaultCrew, file);
    }

    if (isTable(doc.smiths)) {
      for (const [name, raw] of Object.entries(doc.smiths)) {
        if (!isTable(raw)) fail(file, `smiths.${name}`, "expected a table");
        // Such a name reads back what every object inherits, not this smith.
        if (name in Object.prototype)
          fail(
            file,
            `smiths.${name}`,
            `"${name}" is a key every object has; name the smith something else`,
          );
        const base = smiths[name] ?? { name, enabled: true, tags: [] };
        const checked = validateSmith({ ...base, ...raw, name });
        if (!checked.ok) fail(file, `smiths.${name}`, checked.error);
        smiths[name] = checked.value;
        for (const field of Object.keys(raw)) {
          set(`smiths.${name}.${field}`, raw[field], file);
        }
      }
    }

    if (isTable(doc.benches)) {
      for (const [name, raw] of Object.entries(doc.benches)) {
        if (!(BENCH_NAMES as readonly string[]).includes(name)) {
          fail(
            file,
            `benches.${name}`,
            `unknown bench (expected ${BENCH_NAMES.join(" | ")})`,
          );
        }
        benches[name as BenchName] = parseBench(file, name, raw);
        set(`benches.${name}`, benches[name as BenchName], file);
      }
    }

    const execution = doc.execution;
    if (secure && isTable(execution) && isTable(execution.env)) {
      const pass = execution.env.pass;
      if (!Array.isArray(pass) || pass.some((v) => typeof v !== "string")) {
        fail(file, "execution.env.pass", "expected an array of strings");
      }
      envPass = pass as string[];
      set("execution.env.pass", envPass, file);
    }

    // Not a security key: either file may set any value the shift's own
    // bounds allow, and a flag still wins over both.
    if (doc.shift !== undefined) {
      if (!isTable(doc.shift)) fail(file, "shift", "expected a table");
      shift = {
        ...shift,
        ...readShift(file, doc.shift, (key, raw) =>
          set(`shift.${key}`, raw, file),
        ),
      };
    }
  }

  const override = env.AGENT_FORGE_SMITH;
  if (override) {
    defaultCrew = override;
    set("workflow.default_crew", defaultCrew, "env");
  }

  const source = (key: string) => provenance[key]?.source ?? "builtin";
  // Configured means a key of its own: `constructor` is on every object.
  if (!Object.hasOwn(smiths, defaultCrew)) {
    fail(
      source("workflow.default_crew"),
      "workflow.default_crew",
      `unknown smith "${defaultCrew}"`,
    );
  }
  for (const bench of BENCH_NAMES) {
    for (const entry of benches[bench]) {
      if (!Object.hasOwn(smiths, entry.smith)) {
        fail(
          source(`benches.${bench}`),
          `benches.${bench}`,
          `unknown smith "${entry.smith}"`,
        );
      }
    }
  }

  return {
    config: {
      workflow: { defaultCrew },
      smiths,
      benches,
      execution: { envPass },
      shift,
    },
    provenance,
    files,
  };
}
