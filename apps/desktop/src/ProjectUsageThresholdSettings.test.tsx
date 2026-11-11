import { expect, test } from "bun:test";
import { type ComponentChildren, isValidElement } from "preact";
import { NotSent } from "../../../docs/js/operator";
import { attrs, findAll, textOf } from "../../../scripts/dashboard/ds/vnode";
import {
  usageThresholdIntentSchema,
  usageThresholdPendingSchema,
} from "../../../types/usage-threshold-intents";
import {
  type UsageThresholdOriginal,
  usageThresholdJson,
  usageThresholdOriginalSchema,
  usageThresholdRecordSchema,
} from "../../../types/usage-threshold-settings";
import {
  observeUsageThresholdSettings,
  parseUsageRulesDraft,
  type UsageRuleDraft,
  UsageThresholdSettingsView,
  usageRulesDraft,
} from "./ProjectUsageThresholdSettings";
import { ProjectUsageThresholdSettingsOwner } from "./project-usage-threshold-settings-client";

const projectId = "project-00000000-0000-4000-8000-000000000001";
const requestId = "10000000-0000-4000-8000-000000000001";
const workspace = "/workspace";
const instant = "2026-11-11T12:00:00.000Z";
const original = usageThresholdOriginalSchema.parse({
  projectId,
  workspace,
  requestId,
  expectedCatalogRevision: 2,
  expectedRevision: 0,
  rules: [
    {
      id: "20000000-0000-4000-8000-000000000001",
      provider: "codex",
      enabled: true,
      selector: {
        kind: "subscription-window",
        unit: "percent",
        source: "provider-cli",
        label: "five-hour window",
        basis: "used",
      },
      comparison: "at-least",
      threshold: 80,
    },
  ],
});
async function hash(value: UsageThresholdOriginal) {
  const result = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(usageThresholdJson(value)),
  );
  return Array.from(new Uint8Array(result), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
function document(revision = 0) {
  return {
    projectId,
    workspace,
    revision,
    rules: revision ? original.rules : [],
  };
}
async function pending(value = original) {
  return usageThresholdPendingSchema.parse({
    original: value,
    originalHash: await hash(value),
    reservedAt: instant,
  });
}
async function reserved(value = original) {
  return usageThresholdIntentSchema.parse({
    origin: "reservation",
    phase: "reserved",
    ...(await pending(value)),
    discardedAt: null,
    receipt: null,
    document: {
      ...document(),
      projectId: value.projectId,
      workspace: value.workspace,
    },
  });
}
const ok = (data: unknown) => Response.json({ ok: true, data, error: null });
function fixture() {
  const state: {
    catalog: unknown;
    document: unknown;
    recovery: unknown;
    exact: unknown;
  } = {
    catalog: {
      version: 1,
      revision: 2,
      projects: [
        {
          id: projectId,
          slug: "demo",
          name: "Demo",
          description: "",
          icon: "sparkles",
          archived: false,
          pinned: false,
          createdAt: instant,
          updatedAt: instant,
          workspaces: [{ root: workspace, repositories: [], epicIds: [] }],
        },
      ],
    },
    document: document(),
    recovery: { version: 1, complete: true, pending: [] },
    exact: null,
  };
  const posts: Array<{ path: string; body: unknown }> = [];
  let post: (path: string, body: unknown) => Promise<Response> = async () => {
    throw new Error("private lost response");
  };
  const owner = new ProjectUsageThresholdSettingsOwner(
    { projectId, workspace },
    {
      requestId: () => requestId,
      read: async (path) => {
        if (path === "/__agent-forge/projects") return ok(state.catalog);
        if (path.endsWith("/recovery")) return ok(state.recovery);
        if (path.includes("/requests/"))
          return state.exact
            ? ok(state.exact)
            : new Response(null, { status: 404 });
        return ok(state.document);
      },
      post: async (path, body) => {
        posts.push({ path, body: structuredClone(body) });
        return post(path, body);
      },
    },
  );
  let draft = usageRulesDraft(original.rules),
    allowed = true,
    active = owner;
  return {
    owner,
    state,
    posts,
    getDraft: () => draft,
    setActive: (next: ProjectUsageThresholdSettingsOwner) => {
      active = next;
    },
    setPost: (next: typeof post) => {
      post = next;
    },
    setDraft: (next: UsageRuleDraft[]) => {
      draft = next;
    },
    setAllowed: (next: boolean) => {
      allowed = next;
    },
    view: () =>
      UsageThresholdSettingsView({
        owner,
        snapshot: owner.snapshot(),
        draft,
        onDraft: (next) => {
          draft = next;
        },
        writesAllowed: allowed,
        canWrite: () => allowed && active === owner,
      }),
  };
}
function submit(tree: ReturnType<typeof UsageThresholdSettingsView>) {
  const form = findAll(tree, "form")[0];
  if (!form) throw new Error("Missing rules form");
  const handler = attrs(form).onSubmit;
  if (typeof handler !== "function") throw new Error("Missing submit handler");
  return handler({ preventDefault() {} });
}

test("controls validate real producer hashes, explicit empty policies and zero without treating blank as zero", async () => {
  expect(await hash(original)).toBe(
    "8903c93f26a3a9838fb7672396b0e785616eb95f503d9e32a94fa74fd626f0df",
  );
  expect(parseUsageRulesDraft(usageRulesDraft(original.rules))).toEqual(
    original.rules,
  );
  expect(parseUsageRulesDraft([])).toEqual([]);
  const row = usageRulesDraft(original.rules)[0]!;
  expect(
    parseUsageRulesDraft([{ ...row, threshold: "0" }])?.[0]?.threshold,
  ).toBe(0);
  expect(parseUsageRulesDraft([{ ...row, threshold: " " }])).toBeNull();
  expect(parseUsageRulesDraft([{ ...row, threshold: "101" }])).toBeNull();
});
test("explicit valid form Reserve dispatches once and never automatically Applies", async () => {
  const f = fixture();
  await f.owner.refresh();
  expect(f.owner.snapshot().documentFresh).toBe(true);
  expect(f.owner.snapshot().catalog?.member).toBe(true);
  f.setPost(async () => ok(await reserved()));
  const view = f.view();
  expect(textOf(view)).toContain("Reserve these rules");
  await submit(view);
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0]?.path).toEndWith("/settings/usage-thresholds/requests");
  expect(f.owner.snapshot().held?.phase).toBe("reserved");
  expect(
    f.posts.filter((call) => call.path.endsWith("/settings/usage-thresholds")),
  ).toHaveLength(0);
});

function button(
  tree: ReturnType<typeof UsageThresholdSettingsView>,
  label: string,
) {
  const found = findAll(tree, "button").find((node) => textOf(node) === label);
  if (!found) throw new Error("Missing button: " + label);
  return found;
}
function click(
  tree: ReturnType<typeof UsageThresholdSettingsView>,
  label: string,
) {
  const handler = attrs(button(tree, label)).onClick;
  if (typeof handler !== "function") throw new Error("Missing click handler");
  return handler({});
}
async function reviewedFixture() {
  const f = fixture();
  f.state.recovery = { version: 1, complete: true, pending: [await pending()] };
  f.state.exact = await reserved();
  await f.owner.refresh();
  expect(f.posts).toHaveLength(0);
  await f.owner.check();
  expect(f.owner.snapshot().review?.original).toEqual(original);
  return f;
}
async function applied() {
  return usageThresholdRecordSchema.parse({
    receipt: {
      original,
      originalHash: await hash(original),
      outcome: "applied",
      observedRevision: 0,
      resultingRevision: 1,
      settledAt: instant,
      refusalCode: null,
    },
    document: document(1),
  });
}
async function discarded() {
  return usageThresholdIntentSchema.parse({
    ...(await reserved()),
    phase: "discarded",
    discardedAt: instant,
  });
}
test("a known not-sent retry requires fresh checks and preserves the exact original", async () => {
  const f = fixture();
  f.setPost(async () => {
    throw new NotSent("private token failure");
  });
  await f.owner.refresh();
  await submit(f.view());
  expect(f.owner.snapshot().held?.phase).toBe("not-sent");
  const stale = f.view();
  expect(
    attrs(button(stale, "Retry this known not-sent Reserve")).disabled,
  ).toBe(true);
  await click(stale, "Retry this known not-sent Reserve");
  expect(f.posts).toHaveLength(1);
  await f.owner.refresh();
  const checked = f.view();
  expect(
    attrs(button(checked, "Retry this known not-sent Reserve")).disabled,
  ).toBe(false);
  f.setPost(async () => ok(await reserved()));
  await click(checked, "Retry this known not-sent Reserve");
  expect(f.posts).toHaveLength(2);
  expect(f.posts[1]?.body).toEqual(f.posts[0]?.body);
  expect(f.owner.snapshot().held?.phase).toBe("reserved");
});
test("a recovered exact checked original needs an explicit action and duplicate Apply clicks dispatch once", async () => {
  const f = await reviewedFixture();
  f.setPost(async () => ok(await applied()));
  const tree = f.view();
  const summary = findAll(tree, "OriginalSummary")[0];
  expect(attrs(summary).original).toBe(f.owner.snapshot().held?.original);
  expect(attrs(button(tree, "Apply this reviewed original")).disabled).toBe(
    false,
  );
  await Promise.all([
    click(tree, "Apply this reviewed original"),
    click(tree, "Apply this reviewed original"),
  ]);
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0]?.path).toEndWith("/settings/usage-thresholds");
  expect(f.owner.snapshot().lastTerminal?.phase).toBe("applied");
});
test("an older rendered review cannot substitute a newer unseen checked view", async () => {
  const f = await reviewedFixture();
  const old = f.view();
  await f.owner.check();
  f.setPost(async () => ok(await applied()));
  await click(old, "Apply this reviewed original");
  expect(f.posts).toHaveLength(0);
  await click(f.view(), "Apply this reviewed original");
  expect(f.posts).toHaveLength(1);
});
test("Discard stays available for an exact reservation after project removal", async () => {
  const f = await reviewedFixture();
  f.state.catalog = { version: 1, revision: 3, projects: [] };
  await f.owner.check();
  const tree = f.view();
  expect(attrs(button(tree, "Apply this reviewed original")).disabled).toBe(
    true,
  );
  expect(attrs(button(tree, "Discard this reviewed original")).disabled).toBe(
    false,
  );
  f.setPost(async () => ok(await discarded()));
  await click(tree, "Discard this reviewed original");
  expect(f.posts).toHaveLength(1);
  expect(f.posts[0]?.path).toEndWith("/" + requestId + "/discard");
  expect(f.posts[0]?.body).toEqual(original);
  expect(f.owner.snapshot().lastTerminal?.phase).toBe("discarded");
});
test("every saved mutation callback rechecks the current grant and owner before dispatch or minting a permit", async () => {
  for (const revoke of ["permission", "owner"]) {
    const f = fixture();
    await f.owner.refresh();
    const tree = f.view();
    if (revoke === "permission") f.setAllowed(false);
    else f.setActive(fixture().owner);
    await submit(tree);
    expect(f.posts).toHaveLength(0);
    for (const action of ["Apply", "Discard"]) {
      const r = await reviewedFixture();
      let mints = 0;
      const confirm = r.owner.confirmReview.bind(r.owner);
      r.owner.confirmReview = (view, kind) => {
        mints++;
        return confirm(view, kind);
      };
      const before = r.view();
      if (revoke === "permission") r.setAllowed(false);
      else r.setActive(fixture().owner);
      await click(before, action + " this reviewed original");
      expect(r.posts).toHaveLength(0);
      expect(mints).toBe(0);
    }
    const retry = fixture();
    retry.setPost(async () => {
      throw new NotSent("private");
    });
    await retry.owner.refresh();
    await submit(retry.view());
    await retry.owner.refresh();
    const before = retry.view();
    if (revoke === "permission") retry.setAllowed(false);
    else retry.setActive(fixture().owner);
    await click(before, "Retry this known not-sent Reserve");
    expect(retry.posts).toHaveLength(1);
  }
});
test("invalid, duplicate, oversized, unavailable, stale, archived and read-only drafts cannot reserve", async () => {
  const row = usageRulesDraft(original.rules)[0]!;
  for (const bad of ["", " ", "NaN", "Infinity", "-1", "101"]) {
    const f = fixture();
    await f.owner.refresh();
    f.setDraft([{ ...row, threshold: bad }]);
    await submit(f.view());
    expect(f.posts).toHaveLength(0);
  }
  expect(parseUsageRulesDraft([row, row])).toBeNull();
  expect(
    parseUsageRulesDraft(
      Array.from({ length: 101 }, (_, i) => ({
        ...row,
        id: "20000000-0000-4000-8000-" + String(i).padStart(12, "0"),
      })),
    ),
  ).toBeNull();
  for (const mode of ["unavailable", "stale", "archived", "read-only"]) {
    const f = fixture();
    if (mode !== "unavailable") await f.owner.refresh();
    if (mode === "stale") f.owner.invalidateContext();
    if (mode === "archived") {
      f.state.catalog = { version: 1, revision: 3, projects: [] };
      await f.owner.refresh();
    }
    if (mode === "read-only") f.setAllowed(false);
    const tree = f.view();
    expect(attrs(button(tree, "Reserve these rules")).disabled).toBe(true);
    await submit(tree);
    expect(f.posts).toHaveLength(0);
  }
});
test("unknown Reserve remains held and offers checks without automatic Apply or retry", async () => {
  const f = fixture();
  await f.owner.refresh();
  await submit(f.view());
  const tree = f.view();
  expect(textOf(tree)).toContain("unknown reserve outcome");
  expect(textOf(tree)).not.toContain("private lost response");
  expect(
    findAll(tree, "button").some((node) => textOf(node).includes("Apply this")),
  ).toBe(false);
  expect(
    findAll(tree, "button").some((node) => textOf(node).includes("Retry this")),
  ).toBe(false);
  expect(attrs(button(tree, "Reserve these rules")).disabled).toBe(true);
  expect(f.posts).toHaveLength(1);
});
test("subscription teardown leaves a handed-off original alive and silent for the old view", async () => {
  const f = fixture();
  await f.owner.refresh();
  let release: (response: Response) => void = () => {};
  let markHanded: () => void = () => {};
  const handed = new Promise<void>((done) => {
    markHanded = done;
  });
  const response = new Promise<Response>((done) => {
    release = done;
  });
  f.setPost(async () => {
    markHanded();
    return response;
  });
  const seen: unknown[] = [];
  const off = observeUsageThresholdSettings(f.owner, (value) => {
    seen.push(value);
  });
  const saving = submit(f.view());
  await handed;
  off();
  const cutoff = seen.length;
  release(ok(await reserved()));
  await saving;
  expect(seen).toHaveLength(cutoff);
  expect(f.owner.snapshot().disposed).toBe(false);
  expect(f.owner.snapshot().held?.original).toEqual(original);
  expect(f.owner.snapshot().held?.phase).toBe("reserved");
  const current: unknown[] = [];
  const offNew = observeUsageThresholdSettings(f.owner, (value) => {
    current.push(value);
  });
  expect(current[0]).toBe(f.owner.snapshot());
  offNew();
  const ignored = observeUsageThresholdSettings(f.owner, () => {
    throw new Error("private observer");
  });
  ignored();
  expect(f.owner.snapshot().held?.original).toEqual(original);
});
test("local rule controls are labeled, bounded and produce no source writes", async () => {
  const f = fixture();
  await f.owner.refresh();
  let tree = f.view();
  expect(findAll(tree, "fieldset")).toHaveLength(1);
  for (const node of [...findAll(tree, "input"), ...findAll(tree, "select")])
    expect(typeof attrs(node)["aria-label"]).toBe("string");
  await click(tree, "Add rule");
  expect(f.getDraft()).toHaveLength(2);
  expect(f.getDraft()[1]?.id).toMatch(/^[a-f0-9-]{36}$/);
  expect(parseUsageRulesDraft(f.getDraft())).toBeNull();
  tree = f.view();
  await click(tree, "Remove rule 2");
  expect(f.getDraft()).toHaveLength(1);
  expect(f.posts).toHaveLength(0);
  await click(f.view(), "Remove rule 1");
  expect(parseUsageRulesDraft(f.getDraft())).toEqual([]);
  expect(textOf(f.view())).toContain("explicitly configures no rules");
});

function visible(value: ComponentChildren): string {
  if (Array.isArray(value)) return value.map(visible).join("");
  if (!isValidElement(value)) return textOf(value);
  if (
    typeof value.type === "function" &&
    ["RulesSummary", "OriginalSummary"].includes(value.type.name)
  ) {
    const render = value.type as (
      props: Record<string, unknown>,
    ) => ComponentChildren;
    return visible(render(attrs(value)));
  }
  return visible(attrs(value).children as ComponentChildren);
}
test("foreign originals stay descriptive and cannot grant actions in this scope", async () => {
  const f = fixture();
  const foreign = usageThresholdOriginalSchema.parse({
    ...original,
    projectId: "project-00000000-0000-4000-8000-000000000002",
    workspace: "/other-workspace",
    requestId: "10000000-0000-4000-8000-000000000002",
  });
  f.state.recovery = {
    version: 1,
    complete: true,
    pending: [await pending(foreign)],
  };
  await f.owner.refresh();
  const tree = f.view(),
    text = visible(tree);
  expect(text).toContain(foreign.projectId);
  expect(text).toContain(foreign.workspace);
  expect(text).toContain(foreign.requestId);
  expect(text).toContain("this view grants no action on it");
  expect(f.owner.snapshot().held).toBeNull();
  expect(
    findAll(tree, "button").some((node) =>
      /Apply this|Discard this|Check this exact/.test(textOf(node)),
    ),
  ).toBe(false);
  expect(attrs(button(tree, "Reserve these rules")).disabled).toBe(false);
  expect(f.posts).toHaveLength(0);
});
test("newer current policy and an immutable older receipt render separately after read failure", async () => {
  const f = fixture(),
    record = await applied();
  f.state.document = {
    ...document(3),
    rules: [{ ...original.rules[0]!, threshold: 25 }],
  };
  f.state.exact = usageThresholdIntentSchema.parse({
    ...(await reserved()),
    phase: "applied",
    receipt: record.receipt,
    document: record.document,
  });
  await f.owner.check(requestId);
  const tree = f.view(),
    text = visible(tree);
  expect(text).toContain("Policy revision 3");
  expect(text).toContain("Last verified original outcome: applied");
  expect(text).toContain("at-least 25 percent used");
  expect(text).toContain("at-least 80 percent used");
  expect(text).toContain(
    "Expected policy revision 0; expected catalog revision 2",
  );
  expect(text).toContain("current policy may be newer");
  f.state.document = null;
  await f.owner.refresh();
  expect(visible(f.view())).toContain("last verified values; refresh required");
  expect(visible(f.view())).toContain(
    "Last verified original outcome: applied",
  );
  expect(f.posts).toHaveLength(0);
});
test("unknown Apply and Discard remain exact holds without retry or automatic follow-up", async () => {
  for (const action of ["Apply", "Discard"]) {
    const f = await reviewedFixture();
    await click(f.view(), action + " this reviewed original");
    const tree = f.view();
    expect(f.owner.snapshot().held?.original).toEqual(original);
    expect(visible(tree)).toContain(
      "unknown " + action.toLowerCase() + " outcome",
    );
    expect(
      findAll(tree, "button").some((node) =>
        /Retry this|Apply this|Discard this/.test(textOf(node)),
      ),
    ).toBe(false);
    expect(f.posts).toHaveLength(1);
  }
});
test("disposed handoffs remain readable and all old mutation callbacks stay inert", async () => {
  const f = await reviewedFixture(),
    old = f.view();
  const handoff = f.owner.dispose();
  await click(old, "Apply this reviewed original");
  await click(old, "Discard this reviewed original");
  await submit(old);
  expect(f.posts).toHaveLength(0);
  expect(Object.isFrozen(handoff.held?.original)).toBe(true);
  const tree = f.view();
  expect(visible(tree)).toContain("This owner is closed");
  expect(visible(tree)).toContain(requestId);
  expect(
    findAll(tree, "button").some((node) =>
      /Apply this|Discard this/.test(textOf(node)),
    ),
  ).toBe(false);
  expect(attrs(button(tree, "Reserve these rules")).disabled).toBe(true);
});
test("100 unique rules are valid, field edits are local and current grant revocation blocks saved edit callbacks", async () => {
  const row = usageRulesDraft(original.rules)[0]!;
  expect(
    parseUsageRulesDraft(
      Array.from({ length: 100 }, (_, i) => ({
        ...row,
        id: "20000000-0000-4000-8000-" + String(i).padStart(12, "0"),
      })),
    ),
  ).toHaveLength(100);
  const f = fixture();
  await f.owner.refresh();
  const input = findAll(f.view(), "input").find(
    (node) => attrs(node)["aria-label"] === "Rule 1: Threshold",
  );
  const edit = attrs(input).onInput;
  if (typeof edit !== "function") throw new Error("Missing threshold input");
  edit({ currentTarget: { value: "0" } });
  expect(parseUsageRulesDraft(f.getDraft())?.[0]?.threshold).toBe(0);
  f.setAllowed(false);
  edit({ currentTarget: { value: "99" } });
  expect(f.getDraft()[0]?.threshold).toBe("0");
  expect(original.rules[0]?.threshold).toBe(80);
  expect(f.posts).toHaveLength(0);
});
test("an explicitly empty configuration reserves its exact empty original", async () => {
  const f = fixture();
  f.setDraft([]);
  await f.owner.refresh();
  f.setPost(async (_path, body) => {
    const parsed = usageThresholdOriginalSchema
      .omit({ projectId: true })
      .parse(body);
    return ok(await reserved({ projectId, ...parsed }));
  });
  await submit(f.view());
  expect(f.posts).toHaveLength(1);
  expect(f.owner.snapshot().held?.original.rules).toEqual([]);
  expect(f.owner.snapshot().held?.phase).toBe("reserved");
});

test("missing catalog verification explains blocked Apply without disabling exact Discard", async () => {
  const f = await reviewedFixture();
  f.state.catalog = null;
  await f.owner.check();
  expect(f.owner.snapshot().review).not.toBeNull();
  expect(f.owner.snapshot().catalog?.fresh).toBe(false);
  const tree = f.view();
  expect(attrs(button(tree, "Apply this reviewed original")).disabled).toBe(
    true,
  );
  expect(attrs(button(tree, "Discard this reviewed original")).disabled).toBe(
    false,
  );
  expect(visible(tree)).toContain(
    "Project catalog verification is unavailable or stale",
  );
  expect(f.posts).toHaveLength(0);
});
