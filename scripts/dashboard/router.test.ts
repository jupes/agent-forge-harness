import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ROUTE,
  hrefFor,
  isRouteId,
  legacyRedirectFor,
  parseRoute,
  ROUTES,
  type RouteId,
  routeForHashChange,
} from "../../docs/js/router";

describe("route table", () => {
  test("covers every destination the shell navigates to", () => {
    const ids = ROUTES.map((r) => r.id);
    expect(ids).toEqual([
      "dashboard",
      "issues",
      "epics",
      "forge-run",
      "commands",
      "skill-builder",
      "bead-builder",
      "insights",
      "repos",
    ]);
  });

  test("gives every route a label and an icon for the nav", () => {
    for (const route of ROUTES) {
      expect(route.label.length).toBeGreaterThan(0);
      expect(route.icon.length).toBeGreaterThan(0);
    }
  });

  test("groups routes so the nav can show sections", () => {
    const groups = new Set(ROUTES.map((r) => r.group));
    expect(groups).toEqual(new Set(["work", "author"]));
  });
});

describe("parseRoute", () => {
  test("reads the route id out of a hash", () => {
    expect(parseRoute("#/issues")).toBe("issues");
    expect(parseRoute("#/bead-builder")).toBe("bead-builder");
  });

  test("treats an empty, bare or root hash as the dashboard", () => {
    expect(parseRoute("")).toBe(DEFAULT_ROUTE);
    expect(parseRoute("#")).toBe(DEFAULT_ROUTE);
    expect(parseRoute("#/")).toBe(DEFAULT_ROUTE);
  });

  test("tolerates a missing leading slash and trailing slash", () => {
    expect(parseRoute("#issues")).toBe("issues");
    expect(parseRoute("#/issues/")).toBe("issues");
  });

  test("ignores query and nested segments after the route id", () => {
    expect(parseRoute("#/issues?q=auth")).toBe("issues");
    expect(parseRoute("#/epics/agent-forge-harness-dg40")).toBe("epics");
  });

  test("falls back to the dashboard for an unknown route rather than blanking", () => {
    expect(parseRoute("#/nope")).toBe(DEFAULT_ROUTE);
    expect(parseRoute("#/../../etc/passwd")).toBe(DEFAULT_ROUTE);
  });
});

describe("hrefFor", () => {
  test("builds the hash link for a route", () => {
    expect(hrefFor("issues")).toBe("#/issues");
    expect(hrefFor("dashboard")).toBe("#/dashboard");
  });

  test("can target the SPA from another document", () => {
    expect(hrefFor("issues", { fromDocument: true })).toBe(
      "index.html#/issues",
    );
  });
});

describe("legacy ?view= links keep working", () => {
  // The 7 values app.mjs accepted before the router existed. Every one of
  // these may sit in a bookmark or in another page's markup.
  const legacy: [string, RouteId][] = [
    ["dashboard", "dashboard"],
    ["list", "issues"],
    ["epics", "epics"],
    ["commands", "commands"],
    ["skill-builder", "skill-builder"],
    ["bead-builder", "bead-builder"],
    ["insights", "insights"],
  ];

  for (const [view, expected] of legacy) {
    test(`?view=${view} redirects to ${hrefFor(expected)}`, () => {
      expect(legacyRedirectFor(`?view=${view}`, "")).toBe(hrefFor(expected));
    });
  }

  test("leaves modern hash URLs alone", () => {
    expect(legacyRedirectFor("", "#/issues")).toBeNull();
    expect(legacyRedirectFor("?view=list", "#/epics")).toBeNull();
  });

  test("ignores an unknown ?view= value instead of redirecting somewhere wrong", () => {
    expect(legacyRedirectFor("?view=nope", "")).toBeNull();
  });

  test("does not touch other pages' query contracts", () => {
    // council.html?sourceType=plan&source=... and ?run=<id> are read by the
    // Council island itself; the router must not consume or rewrite them.
    expect(
      legacyRedirectFor("?sourceType=plan&source=plans/drafts/x.md", ""),
    ).toBeNull();
    expect(legacyRedirectFor("?run=council-123", "")).toBeNull();
  });

  test("preserves unrelated query params when it does redirect", () => {
    expect(legacyRedirectFor("?view=list&q=auth", "")).toBe("#/issues?q=auth");
  });
});

describe("isRouteId", () => {
  test("narrows unknown strings", () => {
    expect(isRouteId("issues")).toBe(true);
    expect(isRouteId("nope")).toBe(false);
  });
});

describe("routeForHashChange", () => {
  test("keeps the current route for a bare in-page fragment", () => {
    // The skip link's #af-main used to parse as an unknown route and dump the
    // user on Dashboard.
    expect(routeForHashChange("#af-main", "issues")).toBe("issues");
  });

  test("still navigates for route-shaped hashes", () => {
    expect(routeForHashChange("#/epics", "issues")).toBe("epics");
    expect(routeForHashChange("#epics", "issues")).toBe("epics");
    expect(routeForHashChange("", "issues")).toBe(DEFAULT_ROUTE);
  });

  test("an unknown slash route still falls back to the dashboard", () => {
    expect(routeForHashChange("#/nope", "issues")).toBe(DEFAULT_ROUTE);
  });
});
