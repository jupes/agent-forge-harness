import { describe, expect, test } from "bun:test";
import { Icon, type IconName } from "../../../docs/js/ds/Icon";
import { ICON_PATHS } from "../../../docs/js/ds/icon-paths";
import { attrs, nodesOf, tag, textOf } from "./vnode";

/** Every glyph the shell, nav and status vocabulary depend on. */
const REQUIRED: IconName[] = [
  "gauge",
  "list-checks",
  "stack",
  "flow-arrow",
  "terminal-window",
  "sparkle",
  "plus-circle",
  "chart-line",
  "books",
  "file-text",
  "users-three",
  "arrows-clockwise",
  "magnifying-glass",
  "copy",
  "check-circle-fill",
  "circle",
  "circle-half",
  "warning-circle",
  "x",
  "caret-down",
  "caret-right",
  "git-branch",
  "bug",
  "broom",
  "check-square",
  "code",
  "list-bullets",
  "git-pull-request",
  "hammer",
];

describe("icon path data", () => {
  test("ships a non-empty path for every required glyph", () => {
    for (const name of REQUIRED) {
      const d = ICON_PATHS[name];
      expect({ name, ok: typeof d === "string" && d.length > 0 }).toEqual({
        name,
        ok: true,
      });
    }
  });

  test("carries no markup — path data only, so it cannot inject elements", () => {
    for (const d of Object.values(ICON_PATHS)) {
      expect(d).not.toContain("<");
      expect(d).not.toContain("script");
    }
  });
});

describe("Icon", () => {
  test("renders an svg carrying the glyph's path", () => {
    const svg = Icon({ name: "gauge" });
    expect(tag(svg)).toBe("svg");
    expect(attrs(svg)["viewBox"]).toBe("0 0 256 256");
    // Inherits text color so a parent's `color` drives the icon.
    expect(attrs(svg)["fill"]).toBe("currentColor");

    const paths = nodesOf(svg).filter((n) => tag(n) === "path");
    expect(paths).toHaveLength(1);
    expect(attrs(paths[0])["d"]).toBe(ICON_PATHS.gauge);
  });

  test("is decorative by default so screen readers skip it", () => {
    const a = attrs(Icon({ name: "copy" }));
    expect(a["aria-hidden"]).toBe("true");
    expect(a["role"]).toBeUndefined();
    expect(a["aria-label"]).toBeUndefined();
  });

  test("becomes an accessible image when given a label", () => {
    const svg = Icon({ name: "warning-circle", label: "Warning" });
    const a = attrs(svg);
    expect(a["role"]).toBe("img");
    expect(a["aria-label"]).toBe("Warning");
    expect(a["aria-hidden"]).toBeUndefined();
    // A real <title> too — the widest-supported way to name an inline SVG.
    const titles = nodesOf(svg).filter((n) => tag(n) === "title");
    expect(titles).toHaveLength(1);
    expect(textOf(titles[0])).toBe("Warning");
  });

  test("sizes the glyph squarely, defaulting to 16px", () => {
    const d = attrs(Icon({ name: "stack" }));
    expect(d["width"]).toBe(16);
    expect(d["height"]).toBe(16);

    const big = attrs(Icon({ name: "stack", size: 24 }));
    expect(big["width"]).toBe(24);
    expect(big["height"]).toBe(24);
  });

  test("passes a class through so callers can position it", () => {
    expect(attrs(Icon({ name: "x", class: "af-icon-inline" }))["class"]).toBe(
      "af-icon-inline",
    );
  });
});
