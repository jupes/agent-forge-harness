import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const cases = [
  [
    "browser integration controls stay unavailable without native authority",
    ["toBeDisabled", "Review Claude Code registration"],
  ],
  [
    "integration review and Cancel are inert; keyboard confirmation sends one approval and publication",
    ["toBeVisible", "Confirm Claude Code registration"],
  ],
  [
    "lost integration response survives reload and only original recovery can resolve it",
    ["toBeVisible", "Forge configuration confirmed"],
  ],
  [
    "integration review labels and keyboard targets fit desktop minimum in Light and dark",
    ["toBe", "2px", "0px"],
  ],
] as const;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw Error("Unqualified negative controls");
  return value;
}
export function qualifyIntegrationUiNegativeReport(
  report: unknown,
  exitCode: number,
): string[] {
  if (exitCode !== 1 || !record(report) || array(report.errors).length !== 0)
    throw Error("Unqualified negative controls");
  const expected = new Map<string, readonly string[]>(cases),
    seen = new Set<string>();
  function walk(suites: unknown, depth: number) {
    if (depth > 8) throw Error("Unqualified negative controls");
    for (const suite of array(suites)) {
      if (!record(suite)) throw Error("Unqualified negative controls");
      for (const spec of array(suite.specs ?? [])) {
        if (
          !record(spec) ||
          typeof spec.title !== "string" ||
          seen.has(spec.title)
        )
          throw Error("Unqualified negative controls");
        const markers = expected.get(spec.title),
          tests = array(spec.tests);
        if (
          !markers ||
          tests.length !== 1 ||
          !record(tests[0]) ||
          tests[0].expectedStatus !== "passed"
        )
          throw Error("Unqualified negative controls");
        const results = array(tests[0].results),
          result = results[0];
        if (
          results.length !== 1 ||
          !record(result) ||
          result.status !== "failed"
        )
          throw Error("Unqualified negative controls");
        const errors = [result.error, ...array(result.errors ?? [])];
        const rawMessage = errors
          .filter(record)
          .map((x) => (typeof x.message === "string" ? x.message : ""))
          .join("\n");
        const message = stripVTControlCharacters(rawMessage);
        if (markers.some((marker) => !message.includes(marker)))
          throw Error("Unqualified negative controls");
        seen.add(spec.title);
      }
      walk(suite.suites ?? [], depth + 1);
    }
  }
  walk(report.suites, 0);
  if (seen.size !== 4) throw Error("Unqualified negative controls");
  return cases.map((x) => x[0]);
}
if (import.meta.main) {
  try {
    const file = resolve(process.argv[3] ?? "");
    if (
      dirname(file) !== resolve(".tmp/work/mcp-ui-negative") ||
      basename(file) !== "report.json"
    )
      throw Error("Unqualified negative controls");
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024)
      throw Error("Unqualified negative controls");
    const bytes = readFileSync(file);
    if (bytes.length > 2 * 1024 * 1024)
      throw Error("Unqualified negative controls");
    let report: unknown;
    try {
      report = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw Error("Unqualified negative controls");
    }
    const expectedFailures = qualifyIntegrationUiNegativeReport(
      report,
      Number(process.argv[2]),
    );
    console.log(
      JSON.stringify({ ok: true, data: { expectedFailures }, error: null }),
    );
  } catch {
    console.log(
      JSON.stringify({
        ok: false,
        data: null,
        error: "Integration UI negative controls were not qualified.",
      }),
    );
    process.exitCode = 1;
  }
}
