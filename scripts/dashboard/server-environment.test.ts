// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are environment-file text, whose `${NAME}` references the loader expands.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "vite";
import { importGraph } from "../import-graph";
import { loadDashboardServerEnvironment } from "./server-environment";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A root holding the given environment files. */
function rootWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "agent-forge-dashboard-env-"));
  temporaryDirectories.push(root);
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(root, name), text);
  return root;
}

/**
 * What the loader did when it called Vite's `loadEnv`, for the keys the files
 * set. `loadEnv` reads the variables of this process, not an injected set, so
 * a test that compares with it puts its variables in `process.env` (`withEnv`).
 */
function viteLoaded(
  root: string,
  keys: readonly string[],
): Record<string, string | undefined> {
  const loaded: Record<string, string | undefined> = {
    ...loadEnv("development", root, ""),
    ...process.env,
  };
  return Object.fromEntries(keys.map((key) => [key, loaded[key]]));
}

function withEnv<T>(variables: Record<string, string>, body: () => T): T {
  const saved = Object.fromEntries(
    Object.keys(variables).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, variables);
  try {
    return body();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** The forms an environment file can take, each under its own key. */
const FORMS = [
  "# a comment line",
  "",
  "AFT_PLAIN=plain value",
  "AFT_SPACED =  spaced around  ",
  "export AFT_EXPORTED=exported",
  "AFT_COLON: colon form",
  "AFT_EMPTY=",
  "AFT_HASH=before # after",
  "AFT_HASH_TIGHT=before#after",
  "AFT_SINGLE='single # kept'",
  'AFT_DOUBLE="double\\nline"',
  "AFT_BACKTICK=`back 'tick' \"quote\"`",
  "AFT_SINGLE_ESCAPES='no\\nnewline'",
  'AFT_ESCAPED_QUOTE="say \\"hi\\""',
  'AFT_MULTILINE="first',
  'second"',
  'AFT_TRAILING="quoted" # comment',
  "AFT_DOTTED.KEY-NAME=dotted",
  "  AFT_INDENTED=indented",
  "AFT_REPEATED=first",
  "AFT_REPEATED=second",
  "not an assignment",
  "AFT_URL=https://example.test/a?b=c&d=e",
  "AFT_REF=${AFT_PLAIN}/x",
  "AFT_BARE_REF=$AFT_PLAIN-y",
  "AFT_LATER_REF=${AFT_DEFINED_LATER}",
  "AFT_DEFINED_LATER=later",
  "AFT_MISSING=${AFT_NOT_SET_ANYWHERE}",
  "AFT_DEFAULT=${AFT_NOT_SET_ANYWHERE:-fallback}",
  "AFT_DEFAULT_DASH=${AFT_NOT_SET_ANYWHERE-dash}",
  "AFT_ALTERNATE=${AFT_PLAIN:+alternate}",
  "AFT_ALTERNATE_UNSET=${AFT_NOT_SET_ANYWHERE:+alternate}",
  "AFT_ESCAPED_DOLLAR=cost \\$5",
  "AFT_SELF=${AFT_SELF}",
  "AFT_FROM_PROCESS=${AFT_PROCESS_ONLY}",
  "AFT_OVERRIDDEN=from the file",
  "AFT_DOLLAR_IN_VALUE=pa$word",
].join("\r\n");

const FORM_KEYS = [
  "AFT_PLAIN",
  "AFT_SPACED",
  "AFT_EXPORTED",
  "AFT_COLON",
  "AFT_EMPTY",
  "AFT_HASH",
  "AFT_HASH_TIGHT",
  "AFT_SINGLE",
  "AFT_DOUBLE",
  "AFT_BACKTICK",
  "AFT_SINGLE_ESCAPES",
  "AFT_ESCAPED_QUOTE",
  "AFT_MULTILINE",
  "AFT_TRAILING",
  "AFT_DOTTED.KEY-NAME",
  "AFT_INDENTED",
  "AFT_REPEATED",
  "AFT_URL",
  "AFT_REF",
  "AFT_BARE_REF",
  "AFT_LATER_REF",
  "AFT_DEFINED_LATER",
  "AFT_MISSING",
  "AFT_DEFAULT",
  "AFT_DEFAULT_DASH",
  "AFT_ALTERNATE",
  "AFT_ALTERNATE_UNSET",
  "AFT_ESCAPED_DOLLAR",
  "AFT_SELF",
  "AFT_FROM_PROCESS",
  "AFT_OVERRIDDEN",
  "AFT_DOLLAR_IN_VALUE",
] as const;

const PROCESS = {
  AFT_PROCESS_ONLY: "from the process",
  AFT_OVERRIDDEN: "from the process",
};

describe("dashboard server environment", () => {
  test("loads local provider credentials while preserving process overrides", () => {
    const root = rootWith({
      ".env": [
        "DASHBOARD_TEST_FILE_VALUE=value-from-file",
        "DASHBOARD_TEST_OVERRIDE=value-from-file",
      ].join("\n"),
    });

    const environment = loadDashboardServerEnvironment({
      mode: "development",
      root,
      processEnvironment: {
        DASHBOARD_TEST_OVERRIDE: "value-from-process",
      },
    });

    expect(environment.DASHBOARD_TEST_FILE_VALUE).toBe("value-from-file");
    expect(environment.DASHBOARD_TEST_OVERRIDE).toBe("value-from-process");
  });

  test("the four files are read in Vite's order, a later one winning, and a process variable over all of them", () => {
    const root = rootWith({
      ".env": "AFT_A=env\nAFT_B=env\nAFT_C=env\nAFT_D=env\nAFT_E=env\n",
      ".env.local": "AFT_B=env.local\nAFT_C=env.local\nAFT_D=env.local\n",
      ".env.development": "AFT_C=env.development\nAFT_D=env.development\n",
      ".env.development.local": "AFT_D=env.development.local\n",
      ".env.production": "AFT_A=env.production\n",
    });
    mkdirSync(join(root, ".env.test"));
    const environment = loadDashboardServerEnvironment({
      mode: "development",
      root,
      processEnvironment: { AFT_E: "process" },
    });
    expect(
      Object.fromEntries(
        ["AFT_A", "AFT_B", "AFT_C", "AFT_D", "AFT_E"].map((key) => [
          key,
          environment[key],
        ]),
      ),
    ).toEqual({
      AFT_A: "env",
      AFT_B: "env.local",
      AFT_C: "env.development",
      AFT_D: "env.development.local",
      AFT_E: "process",
    });
  });

  test("each form a file can take reads as stated", () => {
    const root = rootWith({ ".env": FORMS });
    const environment = loadDashboardServerEnvironment({
      mode: "development",
      root,
      processEnvironment: PROCESS,
    });
    expect(
      Object.fromEntries(FORM_KEYS.map((key) => [key, environment[key]])),
    ).toEqual({
      AFT_PLAIN: "plain value",
      AFT_SPACED: "spaced around",
      AFT_EXPORTED: "exported",
      AFT_COLON: "colon form",
      AFT_EMPTY: "",
      AFT_HASH: "before",
      AFT_HASH_TIGHT: "before",
      AFT_SINGLE: "single # kept",
      AFT_DOUBLE: "double\nline",
      AFT_BACKTICK: "back 'tick' \"quote\"",
      AFT_SINGLE_ESCAPES: "no\\nnewline",
      AFT_ESCAPED_QUOTE: 'say \\"hi\\"',
      AFT_MULTILINE: "first\nsecond",
      AFT_TRAILING: "quoted",
      "AFT_DOTTED.KEY-NAME": "dotted",
      AFT_INDENTED: "indented",
      AFT_REPEATED: "second",
      AFT_URL: "https://example.test/a?b=c&d=e",
      AFT_REF: "plain value/x",
      AFT_BARE_REF: "plain value-y",
      AFT_LATER_REF: "later",
      AFT_DEFINED_LATER: "later",
      AFT_MISSING: "",
      AFT_DEFAULT: "fallback",
      AFT_DEFAULT_DASH: "dash",
      AFT_ALTERNATE: "alternate",
      AFT_ALTERNATE_UNSET: "",
      AFT_ESCAPED_DOLLAR: "cost $5",
      AFT_SELF: "",
      AFT_FROM_PROCESS: "from the process",
      AFT_OVERRIDDEN: "from the process",
      AFT_DOLLAR_IN_VALUE: "pa",
    });
  });

  test("every form reads as Vite's loadEnv read it", () => {
    const root = rootWith({
      ".env": FORMS,
      ".env.local": "AFT_PLAIN=local plain\nAFT_LOCAL_REF=${AFT_PLAIN}\n",
    });
    const keys = [...FORM_KEYS, "AFT_LOCAL_REF"];
    withEnv(PROCESS, () => {
      const ours = loadDashboardServerEnvironment({
        mode: "development",
        root,
      });
      expect(Object.fromEntries(keys.map((key) => [key, ours[key]]))).toEqual(
        viteLoaded(root, keys),
      );
    });
  });

  test("a reference whose name holds the text null is read whole, where Vite's loadEnv read it as a default", () => {
    const root = rootWith({
      ".env": "nullable=yes\nAFT_NULL_REF=${nullable}\n",
    });
    const ours = loadDashboardServerEnvironment({
      mode: "development",
      root,
      processEnvironment: {},
    });
    expect(ours.AFT_NULL_REF).toBe("yes");
    expect(viteLoaded(root, ["AFT_NULL_REF"])).toEqual({
      AFT_NULL_REF: "able",
    });
  });

  test("the hearth server's entry loads no module of Vite, so it can be compiled without it", () => {
    const graph = importGraph(
      join(import.meta.dir, "..", "hearth", "server.ts"),
    );
    expect(
      graph.bare.filter((name) => name === "vite" || name.startsWith("vite/")),
    ).toEqual([]);
    // The loader is in the graph: the check above reaches it.
    expect(
      graph.files.some((file) =>
        file.endsWith("/scripts/dashboard/server-environment.ts"),
      ),
    ).toBe(true);
  });
});
