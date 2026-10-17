import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { parse } from "yaml";
import { openSettled } from "./fixtures";

/** A markdown file's frontmatter fields and the text after the block. */
function split(text: string): {
  fields: Record<string, unknown>;
  body: string;
} {
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!block) return { fields: {}, body: text };
  const fields: unknown = parse(block[1] ?? "");
  return {
    fields:
      fields !== null && typeof fields === "object" && !Array.isArray(fields)
        ? (fields as Record<string, unknown>)
        : {},
    body: text.slice(block[0].length),
  };
}

/** Each command file's command, its `argument-hint` and the text after the em dash of its first heading. */
function commandFiles(): [string, string, string][] {
  const dir = join(process.cwd(), ".claude", "commands");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file): [string, string, string] => {
      const name = `/${file.slice(0, -".md".length)}`;
      const { fields, body } = split(readFileSync(join(dir, file), "utf8"));
      const heading =
        body.split(/\r?\n/).find((line) => line.startsWith("# ")) ?? "";
      return [
        name,
        String(fields["argument-hint"]),
        heading.slice(`# ${name} — `.length).trim(),
      ];
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Each skill folder's name and the description in its `SKILL.md`, on one line. */
function skillFiles(): [string, string][] {
  const dir = join(process.cwd(), ".claude", "skills");
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry): [string, string] => {
      const { fields } = split(
        readFileSync(join(dir, entry.name, "SKILL.md"), "utf8"),
      );
      return [entry.name, String(fields.description).replace(/\s+/g, " ")];
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

test("the Commands page lists every command file under .claude/commands, each with its argument-hint and its first heading's description", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/commands");

  const rows = page
    .getByRole("region", { name: "Slash commands" })
    .locator("tbody tr");
  const shown = await rows.evaluateAll((trs) =>
    trs.map((tr) =>
      Array.from(tr.querySelectorAll("td"), (td) => td.textContent ?? ""),
    ),
  );

  expect(shown).toEqual(commandFiles());
});

test("the Commands page lists every skill folder under .claude/skills, each with its description up to the trigger text", async ({
  page,
}) => {
  await openSettled(page, "/index.html#/commands");

  const rows = page
    .getByRole("region", { name: "Skills", exact: true })
    .locator("tbody tr");
  const shown = await rows.evaluateAll((trs) =>
    trs.map((tr) => ({
      name: tr.querySelector("td")?.textContent ?? "",
      summary: tr.querySelector(".af-skill-summary")?.textContent ?? "",
    })),
  );

  const files = skillFiles();
  expect(shown.map(({ name }) => name)).toEqual(files.map(([name]) => name));
  for (const { name, summary } of shown) {
    const description = new Map(files.map(([n, d]) => [n, d])).get(name) ?? "";
    const kept = summary.replace(/…$/, "");
    expect(kept.length, `${name} has a summary`).toBeGreaterThan(0);
    expect(
      description.startsWith(kept),
      `${name}'s summary is its description`,
    ).toBe(true);
    expect(summary, `${name}'s summary has no trigger text`).not.toMatch(
      /\bUse (when|this|for)\b/,
    );
  }
});
