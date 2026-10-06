/**
 * Layered config for smiths, benches and the executor env allowlist.
 *
 * Precedence, low to high: builtin < ~/.agent-forge/config.toml <
 * <harness>/agent-forge.toml < env. Every effective value carries its
 * provenance. Security keys (`execution.env.pass`) are never inherited from the
 * user file once a workspace file exists (decision #17).
 *
 * Parsing uses the runtime's `Bun.TOML` — no dependency.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { BENCH_NAMES, type BenchName, type Smith } from "../../types/hearth";
import { validateSmith } from "../hearth/validate";
import {
  type BenchEntry,
  BUILTIN_BENCHES,
  BUILTIN_DEFAULT_CREW,
  BUILTIN_SMITHS,
} from "./defaults";

export interface Provenance {
  value: unknown;
  /** "builtin", "env", or the absolute path of the file the value came from. */
  source: string;
}

export interface ForgeConfig {
  workflow: { defaultCrew: string };
  smiths: Record<string, Smith>;
  benches: Record<BenchName, BenchEntry[]>;
  execution: { envPass: string[] };
}

export interface LoadedConfig {
  config: ForgeConfig;
  provenance: Record<string, Provenance>;
  files: string[];
}

export interface LoadOptions {
  harnessRoot: string;
  home?: string;
  env?: Record<string, string | undefined>;
}

type Table = Record<string, unknown>;

function isTable(v: unknown): v is Table {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(file: string, key: string, message: string): never {
  throw new Error(`${file}: ${key}: ${message}`);
}

function readToml(file: string): Table {
  try {
    const parsed = Bun.TOML.parse(readFileSync(file, "utf8"));
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
  const userFile = join(
    options.home ?? homedir(),
    ".agent-forge",
    "config.toml",
  );
  const workspaceFile = join(options.harnessRoot, "agent-forge.toml");
  const hasWorkspace = existsSync(workspaceFile);

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

  const layers: Array<{ file: string; secure: boolean }> = [
    { file: userFile, secure: !hasWorkspace },
    { file: workspaceFile, secure: true },
  ];
  for (const { file, secure } of layers) {
    if (!existsSync(file)) continue;
    files.push(file);
    const doc = readToml(file);

    const workflow = doc.workflow;
    if (isTable(workflow) && typeof workflow.default_crew === "string") {
      defaultCrew = workflow.default_crew;
      set("workflow.default_crew", defaultCrew, file);
    }

    if (isTable(doc.smiths)) {
      for (const [name, raw] of Object.entries(doc.smiths)) {
        if (!isTable(raw)) fail(file, `smiths.${name}`, "expected a table");
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
  }

  const override = env.AGENT_FORGE_SMITH;
  if (override) {
    defaultCrew = override;
    set("workflow.default_crew", defaultCrew, "env");
  }

  const source = (key: string) => provenance[key]?.source ?? "builtin";
  if (!smiths[defaultCrew]) {
    fail(
      source("workflow.default_crew"),
      "workflow.default_crew",
      `unknown smith "${defaultCrew}"`,
    );
  }
  for (const bench of BENCH_NAMES) {
    for (const entry of benches[bench]) {
      if (!smiths[entry.smith]) {
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
    },
    provenance,
    files,
  };
}
