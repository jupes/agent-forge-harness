import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const TOKENS_PATH = join(REPO_ROOT, "docs", "js", "ds", "tokens.css");

function tokenSheet(): string {
  return readFileSync(TOKENS_PATH, "utf8");
}

/** Custom properties declared anywhere in the sheet, e.g. `--color-bg`. */
function declaredTokens(css: string): Set<string> {
  return new Set(
    [...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string),
  );
}

/** `url(...)` targets inside @font-face blocks, unquoted. */
function fontFaceUrls(css: string): string[] {
  return [...css.matchAll(/@font-face\s*\{[^}]*\}/g)].flatMap((block) =>
    [...(block[0] ?? "").matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map(
      (m) => m[1] as string,
    ),
  );
}

describe("Nocturne token sheet", () => {
  test("exists at docs/js/ds/tokens.css", () => {
    expect(existsSync(TOKENS_PATH)).toBe(true);
  });

  test("declares the role colors, ramps, type, spacing, radii and shadow tokens", () => {
    const tokens = declaredTokens(tokenSheet());

    for (const role of ["bg", "surface", "text", "accent", "divider"]) {
      expect(tokens).toContain(`--color-${role}`);
    }
    // 100-900 tonal ramps on one shared perceptual lightness scale.
    for (const ramp of ["neutral", "accent"]) {
      for (let step = 100; step <= 900; step += 100) {
        expect(tokens).toContain(`--color-${ramp}-${step}`);
      }
    }
    for (const token of [
      "--font-heading",
      "--font-heading-weight",
      "--font-body",
      "--radius-sm",
      "--radius-md",
      "--radius-lg",
      "--shadow-sm",
      "--shadow-md",
      "--shadow-lg",
    ]) {
      expect(tokens).toContain(token);
    }
    // Density 0.7x scale: 1,2,3,4,6,8 (no 5 or 7 — matches Nocturne).
    for (const step of [1, 2, 3, 4, 6, 8]) {
      expect(tokens).toContain(`--space-${step}`);
    }
  });

  test("carries Nocturne's ground and accent values", () => {
    const css = tokenSheet();
    expect(css).toMatch(/--color-bg:\s*#161826/);
    expect(css).toMatch(/--color-text:\s*#e9e9ed/);
    expect(css).toMatch(/--color-accent:\s*#9184d9/);
  });

  test("references no external font or icon CDN", () => {
    const css = tokenSheet();
    for (const host of [
      "fonts.googleapis.com",
      "fonts.gstatic.com",
      "unpkg.com",
      "cdnjs",
      "jsdelivr",
    ]) {
      expect(css).not.toContain(host);
    }
  });

  test("self-hosts Inter: every @font-face url resolves to a file on disk", () => {
    const urls = fontFaceUrls(tokenSheet());
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith("http")).toBe(false);
      const abs = resolve(dirname(TOKENS_PATH), url);
      expect({ url, exists: existsSync(abs) }).toEqual({ url, exists: true });
    }
  });

  test("ships the SIL Open Font License alongside the font files", () => {
    const licensePath = join(REPO_ROOT, "docs", "fonts", "LICENSE-Inter.txt");
    expect(existsSync(licensePath)).toBe(true);
    expect(readFileSync(licensePath, "utf8")).toContain(
      "SIL OPEN FONT LICENSE",
    );
  });

  test("falls back to a system stack when a font file cannot load", () => {
    const css = tokenSheet();
    expect(css).toMatch(/--font-body:[^;]*system-ui/);
    expect(css).toMatch(/--font-heading:[^;]*system-ui/);
  });

  test("uses font-display: swap so text paints before Inter arrives", () => {
    expect(tokenSheet()).toMatch(/font-display:\s*swap/);
  });
});
