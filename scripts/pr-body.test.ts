import { expect, test } from "bun:test";
import { join } from "node:path";
import { validatePrBody } from "./pr-body";

const headings = [
  "What Changed",
  "Why It's Needed",
  "How It Was Tested",
  "Test Evidence",
  "Risk & Rollback",
  "Linked Issues & AC Trace",
];
const bodies = [
  {
    body: headings
      .map((name) => `## ${name}\n\nRecorded evidence.\n`)
      .join("\n"),
    result: {
      ok: true,
      data: { present: headings, missing: [], empty: [] },
      error: null,
    },
  },
  {
    body: "## What Changed\n\nActual change.\n## Why It's Needed\n\n<!-- fill me -->\n- <reason>\n",
    result: {
      ok: false,
      data: {
        present: headings.slice(0, 2),
        missing: headings.slice(2),
        empty: ["Why It's Needed"],
      },
      error:
        "missing sections: How It Was Tested, Test Evidence, Risk & Rollback, Linked Issues & AC Trace; empty/placeholder sections: Why It's Needed",
    },
  },
];

test("the pure canonical validator and source stdin entry retain identical original envelopes", () => {
  for (const fixture of bodies) {
    expect(validatePrBody(fixture.body)).toEqual(fixture.result);
    for (const directory of [".claude", ".agents"]) {
      const source = Bun.spawnSync(
        [
          process.execPath,
          join(
            import.meta.dir,
            `../${directory}/skills/pr-description/scripts/check-pr-body.ts`,
          ),
          "-",
        ],
        {
          stdin: new TextEncoder().encode(fixture.body),
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        },
      );
      expect(source.exitCode).toBe(fixture.result.ok ? 0 : 1);
      let result: unknown;
      try {
        result = JSON.parse(source.stdout.toString());
      } catch {
        throw Error("Source validator did not emit its original envelope");
      }
      expect(result).toEqual(fixture.result);
      expect(source.stderr.toString()).toBe("");
    }
  }
});
