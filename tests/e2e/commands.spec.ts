import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openSettled } from "./fixtures";

/** Each command file's command and the text after the em dash of its first heading. */
function commandFiles(): [string, string][] {
  const dir = join(process.cwd(), ".claude", "commands");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md"))
    .map((file): [string, string] => {
      const name = `/${file.slice(0, -".md".length)}`;
      const heading =
        readFileSync(join(dir, file), "utf8")
          .split(/\r?\n/)
          .find((line) => line.startsWith("# ")) ?? "";
      return [name, heading.slice(`# ${name} — `.length).trim()];
    })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

test("the Commands page lists every command file under .claude/commands, each with its first heading's description", async ({
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
