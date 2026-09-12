import { describe, expect, test } from "bun:test";
import { Button } from "../../../docs/js/ds/Button";
import { Card } from "../../../docs/js/ds/Card";
import { Field, Input, Select, Textarea } from "../../../docs/js/ds/Field";
import { Table } from "../../../docs/js/ds/Table";
import { Tag } from "../../../docs/js/ds/Tag";
import { attrs, findAll, tag, textOf } from "./vnode";

describe("Button", () => {
  test("renders a real button with an explicit type", () => {
    const el = Button({ children: "Convene council" });
    expect(tag(el)).toBe("button");
    // Without this, a button inside a form submits it — a classic silent bug.
    expect(attrs(el)["type"]).toBe("button");
    expect(textOf(el)).toBe("Convene council");
  });

  test("carries its variant as a class so the token sheet can style it", () => {
    expect(attrs(Button({ children: "a" }))["class"]).toContain(
      "af-btn-secondary",
    );
    expect(
      attrs(Button({ variant: "primary", children: "a" }))["class"],
    ).toContain("af-btn-primary");
    expect(
      attrs(Button({ variant: "ghost", children: "a" }))["class"],
    ).toContain("af-btn-ghost");
    expect(attrs(Button({ children: "a" }))["class"]).toContain("af-btn");
  });

  test("passes through disabled, onClick, title and extra classes", () => {
    const onClick = () => {};
    const a = attrs(
      Button({
        children: "x",
        disabled: true,
        onClick,
        title: "why",
        class: "extra",
      }),
    );
    expect(a["disabled"]).toBe(true);
    expect(a["onClick"]).toBe(onClick);
    expect(a["title"]).toBe("why");
    expect(a["class"]).toContain("extra");
  });

  test("renders a leading icon when asked, without announcing it twice", () => {
    const el = Button({ icon: "arrows-clockwise", children: "Refresh" });
    const icons = findAll(el, "Icon");
    expect(icons).toHaveLength(1);
    // Label lives in the button text, so the glyph stays decorative.
    expect(attrs(icons[0])["label"]).toBeUndefined();
  });

  test("can render as a link when given href, keeping button styling", () => {
    const el = Button({ href: "council.html", children: "Open council" });
    expect(tag(el)).toBe("a");
    expect(attrs(el)["href"]).toBe("council.html");
    expect(attrs(el)["class"]).toContain("af-btn");
    // An anchor must not carry a button type attribute.
    expect(attrs(el)["type"]).toBeUndefined();
  });
});

describe("Tag", () => {
  test("renders its label with a tone class", () => {
    const el = Tag({ children: "open" });
    expect(textOf(el)).toBe("open");
    expect(attrs(el)["class"]).toContain("af-tag");
    expect(attrs(el)["class"]).toContain("af-tag-neutral");
    expect(attrs(Tag({ tone: "accent", children: "x" }))["class"]).toContain(
      "af-tag-accent",
    );
    expect(attrs(Tag({ tone: "outline", children: "x" }))["class"]).toContain(
      "af-tag-outline",
    );
  });
});

describe("Card", () => {
  test("renders a surface with optional kicker, title and body", () => {
    const el = Card({
      kicker: "Forge run",
      title: "council-kernel",
      children: "body text",
    });
    expect(attrs(el)["class"]).toContain("af-card");
    expect(textOf(el)).toContain("Forge run");
    expect(textOf(el)).toContain("council-kernel");
    expect(textOf(el)).toContain("body text");
  });

  test("omits the header entirely when it has no kicker or title", () => {
    const el = Card({ children: "just body" });
    expect(findAll(el, "header")).toHaveLength(0);
    expect(textOf(el)).toBe("just body");
  });

  test("titles render as a heading at the caller's level for document outline", () => {
    const el = Card({ title: "Seats", headingLevel: 2 });
    expect(findAll(el, "h2")).toHaveLength(1);
    expect(findAll(Card({ title: "Seats" }), "h3")).toHaveLength(1);
  });
});

describe("Table", () => {
  const columns = [
    { key: "id", header: "Id" },
    { key: "title", header: "Title" },
  ];
  const rows = [
    { id: "af-1", title: "First" },
    { id: "af-2", title: "Second" },
  ];

  test("renders a semantic table with a header row per column", () => {
    const el = Table({
      columns,
      rows,
      rowKey: (r: (typeof rows)[number]) => r.id,
    });
    expect(tag(el)).toBe("div");
    const tables = findAll(el, "table");
    expect(tables).toHaveLength(1);
    const headers = findAll(el, "th");
    expect(headers).toHaveLength(2);
    expect(headers.map((h) => textOf(h))).toEqual(["Id", "Title"]);
    // Column headers must be scoped for screen readers.
    expect(attrs(headers[0])["scope"]).toBe("col");
  });

  test("renders one row per record, cells in column order", () => {
    const el = Table({
      columns,
      rows,
      rowKey: (r: (typeof rows)[number]) => r.id,
    });
    const bodyRows = findAll(el, "tr").filter(
      (r) => findAll(r, "td").length > 0,
    );
    expect(bodyRows).toHaveLength(2);
    expect(findAll(bodyRows[0], "td").map((c) => textOf(c))).toEqual([
      "af-1",
      "First",
    ]);
  });

  test("wraps in a horizontally scrollable region so wide tables never break the page", () => {
    const el = Table({
      columns,
      rows,
      rowKey: (r: (typeof rows)[number]) => r.id,
    });
    expect(attrs(el)["class"]).toContain("af-table-scroll");
    // A scrollable region must be focusable and named to be keyboard-reachable.
    expect(attrs(el)["tabIndex"]).toBe(0);
    expect(attrs(el)["role"]).toBe("region");
  });

  test("shows an empty state instead of a headerless void when there are no rows", () => {
    const el = Table({
      columns,
      rows: [],
      rowKey: (r: { id: string }) => r.id,
      empty: "No issues match this filter.",
    });
    expect(textOf(el)).toContain("No issues match this filter.");
    expect(findAll(el, "tbody")).toHaveLength(0);
  });
});

describe("Field", () => {
  test("ties its label to the control by id", () => {
    const el = Field({
      label: "Run budget (USD)",
      id: "budget",
      children: Input({ id: "budget", value: "5.00" }),
    });
    const labels = findAll(el, "label");
    expect(labels).toHaveLength(1);
    expect(attrs(labels[0])["for"]).toBe("budget");
    expect(textOf(labels[0])).toContain("Run budget (USD)");
  });

  test("marks required fields for both sighted and assistive users", () => {
    const el = Field({
      label: "Title",
      id: "t",
      required: true,
      children: null,
    });
    expect(textOf(el)).toContain("*");
    const marks = findAll(el, "abbr");
    expect(attrs(marks[0])["title"]).toBe("required");
  });

  test("renders hint text and links it to the control via aria-describedby", () => {
    const el = Field({
      label: "Repo",
      id: "repo",
      hint: "`.` for the harness root",
      children: null,
    });
    expect(textOf(el)).toContain("`.` for the harness root");
    const hints = findAll(el, "p");
    expect(attrs(hints[0])["id"]).toBe("repo-hint");
  });

  test("Input, Textarea and Select render their native elements with the shared class", () => {
    expect(tag(Input({ id: "a" }))).toBe("input");
    expect(attrs(Input({ id: "a" }))["class"]).toContain("af-input");
    expect(tag(Textarea({ id: "b" }))).toBe("textarea");
    expect(attrs(Textarea({ id: "b" }))["class"]).toContain("af-input");
    expect(tag(Select({ id: "c", children: null }))).toBe("select");
    expect(attrs(Select({ id: "c", children: null }))["class"]).toContain(
      "af-input",
    );
  });

  test("Input forwards aria-describedby so a hint is announced with the control", () => {
    const a = attrs(Input({ id: "repo", describedBy: "repo-hint" }));
    expect(a["aria-describedby"]).toBe("repo-hint");
  });
});
