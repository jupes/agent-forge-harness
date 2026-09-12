import { expect, test } from "bun:test";
import { type ComponentChildren, isValidElement, type VNode } from "preact";
import { CouncilHistory } from "../../docs/js/islands/CouncilHistory";
import { CouncilMembers } from "../../docs/js/islands/CouncilMembers";
import {
  type CouncilDraft,
  CouncilSetup,
  optionalBudget,
  type ProfileChoice,
} from "../../docs/js/islands/CouncilSetup";
import { councilPlanSource } from "../../docs/js/islands/PlanReviewIsland";
import { providerReadiness } from "./providers";
import type { CouncilServiceJob } from "./service";
import { loadCouncilProfile } from "./workflow";

type Element = VNode<Record<string, unknown>>;
function nodes(value: ComponentChildren): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement(value)) return [];
  return [value as Element, ...nodes(value.props.children)];
}
function text(value: ComponentChildren): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (isValidElement(value)) return text(value.props.children);
  return value === null || value === undefined || typeof value === "boolean"
    ? ""
    : String(value);
}
const profile = loadCouncilProfile("councils/default.json");
const profiles: ProfileChoice[] = [
  { ...profile, path: "demo.json", readiness: providerReadiness(profile) },
  {
    ...profile,
    path: "other.json",
    title: "Other",
    maxEstimatedUsd: 7,
    readiness: providerReadiness(profile),
  },
];
const draft: CouncilDraft = {
  sourceType: "text",
  source: "Review this plan",
  profilePath: "demo.json",
  budget: "1",
  redactSecrets: false,
};
const noop = async () => {};
function setup(overrides: Partial<Parameters<typeof CouncilSetup>[0]> = {}) {
  return CouncilSetup({
    draft,
    profiles,
    active: false,
    starting: false,
    onChange: () => {},
    onStart: noop,
    onCancel: noop,
    ...overrides,
  });
}

test("setup component forwards edits and profile budget changes without owning run state", () => {
  const patches: Partial<CouncilDraft>[] = [];
  const all = nodes(setup({ onChange: (patch) => patches.push(patch) }));
  const selects = all.filter(
    (node) => typeof node.type === "function" && node.type.name === "Select",
  );
  const change = (node: Element, value: string) =>
    (
      node.props.onChange as (event: {
        currentTarget: { value: string };
      }) => void
    )({ currentTarget: { value } });
  change(selects[0]!, "pr");
  change(selects[1]!, "other.json");
  expect(patches).toEqual([
    { sourceType: "pr" },
    { profilePath: "other.json", budget: "7" },
  ]);
  expect(text(setup())).toContain("Demo profile: simulated feedback");
});

test("setup component preserves start validation and active-review locking", () => {
  expect(optionalBudget("")).toBeUndefined();
  expect(optionalBudget("  ")).toBeUndefined();
  expect(optionalBudget("2.5")).toBe(2.5);
  const startButton = (tree: ComponentChildren) =>
    nodes(tree).find(
      (node) =>
        typeof node.type === "function" &&
        node.type.name === "Button" &&
        text(node.props.children as ComponentChildren).includes(
          "Convene council",
        ),
    )!;
  expect(startButton(setup()).props.disabled).toBe(false);
  for (const budget of ["", "-1", "not-a-number"]) {
    expect(
      startButton(setup({ draft: { ...draft, budget } })).props.disabled,
    ).toBe(true);
  }
  expect(
    startButton(setup({ draft: { ...draft, source: " " } })).props.disabled,
  ).toBe(true);
  expect(startButton(setup({ profiles: [] })).props.disabled).toBe(true);
  const active = setup({ active: true });
  expect(startButton(active).props.disabled).toBe(true);
  expect(
    nodes(active)
      .filter((node) =>
        ["select", "input", "textarea"].includes(String(node.type)),
      )
      .every((node) => node.props.disabled),
  ).toBe(true);
  expect(text(active)).toContain("Stop review");
});

test("council plan links honor committed-only plans and history selection", () => {
  const catalog = { draftIds: ["draft"], committedIds: ["committed"] };
  expect(councilPlanSource(catalog, "committed", "draft", "drafts")).toBe(
    "plans/committed/committed.md",
  );
  expect(councilPlanSource(catalog, "draft", "diff", "committed")).toBe(
    "plans/drafts/draft.md",
  );
  expect(councilPlanSource(catalog, "draft", "history", "committed")).toBe(
    "plans/committed/draft.md",
  );
});

test("member and history components retain selected-run identity and callbacks", () => {
  const job: CouncilServiceJob = {
    runId: "saved-review",
    status: "completed",
    startedAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:01Z",
    events: [
      {
        schemaVersion: 1,
        runId: "saved-review",
        seq: 0,
        at: "2026-09-01T00:00:01Z",
        type: "seat.completed",
        payload: { seatId: profile.seats[0]!.id, stage: "revision" },
      },
    ],
  };
  const members = text(CouncilMembers({ job, roster: profile.seats }));
  const rosterKicker = (job: CouncilServiceJob | null) =>
    String(
      (CouncilMembers({ job, roster: profile.seats }) as Element).props
        .kicker ?? "",
    ).toLowerCase();
  expect(rosterKicker(job)).toContain("members for the selected run");
  expect(members).toContain("revision · complete");
  const opened: string[] = [];
  const history = CouncilHistory({
    history: [job],
    selectedRunId: job.runId,
    onOpen: async (id) => {
      opened.push(id);
    },
  });
  const button = nodes(history).find((node) => node.type === "button")!;
  // Selection is now both a class and an aria-current flag.
  expect(String(button.props.class)).toContain("is-selected");
  expect(button.props["aria-current"]).toBe("true");
  (button.props.onClick as () => void)();
  expect(opened).toEqual([job.runId]);
});
