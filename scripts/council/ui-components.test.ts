import { expect, test } from "bun:test";
import { type ComponentChildren, isValidElement, type VNode } from "preact";
import {
  type CouncilPreviewState,
  needsPreview,
  previewAllowsSend,
  previewKey,
  previewOf,
} from "../../docs/js/council-preview";
import { CouncilHistory } from "../../docs/js/islands/CouncilHistory";
import { CouncilMembers } from "../../docs/js/islands/CouncilMembers";
import {
  type CouncilDraft,
  CouncilSetup,
  optionalBudget,
  type ProfileChoice,
} from "../../docs/js/islands/CouncilSetup";
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
    preview: { status: "idle" },
    onChange: () => {},
    onStart: noop,
    onCancel: noop,
    onPreview: noop,
    ...overrides,
  });
}

function button(tree: ComponentChildren, label: string): Element | undefined {
  return nodes(tree).find(
    (node) =>
      typeof node.type === "function" &&
      node.type.name === "Button" &&
      text(node.props.children as ComponentChildren).includes(label),
  );
}

const BEAD = "demo-harness-ab12.3";
const beadDraft: CouncilDraft = { ...draft, sourceType: "bead", source: BEAD };
const LISTING = [
  "E1 acceptance criteria: 240 bytes",
  "E2 latest comments: 2 comments, 180 bytes",
  "description: none",
];
const ready = (forDraft: CouncilDraft): CouncilPreviewState => ({
  status: "ready",
  key: previewKey(forDraft),
  preview: {
    source: {
      kind: "bead",
      displayName: `${BEAD}: Teach the kiln`,
      locator: BEAD,
    },
    byteLength: 420,
    truncated: false,
    redactions: [],
    listing: LISTING,
  },
});

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

test("the source list offers a Beads issue, and a bead is entered on one line", () => {
  const options = nodes(setup()).filter((node) => node.type === "option");
  expect(options.map((node) => node.props.value)).toContain("bead");
  expect(
    text(
      options.find((node) => node.props.value === "bead")?.props
        .children as ComponentChildren,
    ),
  ).toBe("Beads issue");
  const inputs = (tree: ComponentChildren) =>
    nodes(tree)
      .filter(
        (node) =>
          typeof node.type === "function" &&
          ["Input", "Textarea"].includes(node.type.name) &&
          node.props.id === "council-source",
      )
      .map((node) => (node.type as { name: string }).name);
  expect(inputs(setup({ draft: beadDraft }))).toEqual(["Input"]);
  expect(inputs(setup())).toEqual(["Textarea"]);
  const label = nodes(setup({ draft: beadDraft })).find(
    (node) =>
      typeof node.type === "function" &&
      node.type.name === "Field" &&
      node.props.id === "council-source",
  )?.props.label;
  expect(label).toBe("Beads issue id");
});

test("a bead is not sent before its evidence is shown: Convene waits for a preview of this very draft, which lists each part", async () => {
  const previews: number[] = [];
  const onPreview = async () => {
    previews.push(1);
  };
  // Nothing previewed yet: the preview is offered, the run is not.
  const idle = setup({ draft: beadDraft, onPreview });
  expect(button(idle, "Convene council")?.props.disabled).toBe(true);
  const offered = button(idle, "Preview evidence");
  expect(offered?.props.disabled).toBe(false);
  (offered?.props.onClick as () => void)();
  expect(previews).toEqual([1]);
  expect(text(idle)).not.toContain("E1 acceptance criteria");

  // While it is read: neither.
  const loading = setup({
    draft: beadDraft,
    preview: { status: "loading", key: previewKey(beadDraft) },
  });
  expect(button(loading, "Convene council")?.props.disabled).toBe(true);
  expect(button(loading, "Reading the bead")?.props.disabled).toBe(true);

  // Read: every line of the listing is shown, and the run may be sent.
  const shown = setup({ draft: beadDraft, preview: ready(beadDraft) });
  const listing = nodes(shown).find(
    (node) => node.props["data-testid"] === "council-preview-listing",
  );
  expect(
    nodes(listing?.props.children as ComponentChildren)
      .filter((node) => node.type === "li")
      .map((node) => text(node.props.children as ComponentChildren)),
  ).toEqual(LISTING);
  expect(text(shown)).toContain(`${BEAD}: Teach the kiln`);
  expect(button(shown, "Convene council")?.props.disabled).toBe(false);

  // A preview of another bead, or of the same bead under the other secret
  // policy, is no preview of this draft.
  for (const changed of [
    { ...beadDraft, source: "demo-harness-ab12.4" },
    { ...beadDraft, redactSecrets: true },
  ]) {
    const stale = setup({ draft: changed, preview: ready(beadDraft) });
    expect(button(stale, "Convene council")?.props.disabled).toBe(true);
    expect(text(stale)).not.toContain("E1 acceptance criteria");
  }
  // Space around the id is not another draft.
  expect(
    button(
      setup({
        draft: { ...beadDraft, source: ` ${BEAD}\n` },
        preview: ready(beadDraft),
      }),
      "Convene council",
    )?.props.disabled,
  ).toBe(false);

  // A preview that failed says why, and the run is not offered.
  const failed = setup({
    draft: beadDraft,
    preview: {
      status: "failed",
      key: previewKey(beadDraft),
      error: "bd --readonly show failed (1): no issue found",
    },
  });
  expect(text(failed)).toContain("bd --readonly show failed (1)");
  expect(button(failed, "Convene council")?.props.disabled).toBe(true);
  expect(button(failed, "Preview evidence")?.props.disabled).toBe(false);
});

test("the preview is the bead kind's alone: other sources are sent as before, and no preview is offered for them", () => {
  for (const sourceType of ["text", "pr", "plan", "file"]) {
    const tree = setup({ draft: { ...draft, sourceType } });
    expect(button(tree, "Preview evidence")).toBeUndefined();
    expect(button(tree, "Convene council")?.props.disabled).toBe(false);
  }
  expect(needsPreview("bead")).toBe(true);
  expect(previewAllowsSend({ status: "idle" }, draft)).toBe(true);
  expect(previewAllowsSend({ status: "idle" }, beadDraft)).toBe(false);
  expect(previewOf(ready(beadDraft), { ...beadDraft, source: "x" })).toEqual({
    status: "idle",
  });
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
