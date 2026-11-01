import { expect, test } from "bun:test";
import { toChildArray } from "preact";
import { InboxPermissionChoices } from "./Inbox";

function clickChoice(view: ReturnType<typeof InboxPermissionChoices>, index: number) {
  const children = toChildArray(view.props.children);
  const choice = children[index];
  if (!choice || typeof choice !== "object" || !("props" in choice))
    throw Error("The permission view has no button choice.");
  const buttonProps = choice.props;
  if (!buttonProps || typeof buttonProps !== "object" || !("onClick" in buttonProps))
    throw Error("The permission choice has no click action.");
  if (typeof buttonProps.onClick !== "function")
    throw Error("The permission choice action is unavailable.");
  buttonProps.onClick();
}

test("the Codex permission subview exposes only current offered choices and forwards the exact decision", () => {
  const chosen: Array<[string, string]> = [];
  const current = InboxPermissionChoices({
    label: "Codex permission decisions",
    offerId: "codex-offer-1",
    choices: [
      { value: "accept", label: "Allow once" },
      { value: "decline", label: "Deny" },
    ],
    disabled: false,
    onChoose: (offerId, value) => chosen.push([offerId, value]),
  });
  expect(current.props["aria-label"]).toBe("Codex permission decisions");
  expect(toChildArray(current.props.children)).toHaveLength(2);
  clickChoice(current, 0);
  clickChoice(current, 1);
  expect(chosen).toEqual([["codex-offer-1", "accept"], ["codex-offer-1", "decline"]]);

  const stale = InboxPermissionChoices({
    label: "Codex permission decisions",
    offerId: "codex-offer-1",
    choices: [],
    disabled: true,
    onChoose: (offerId, value) => chosen.push([offerId, value]),
  });
  expect(toChildArray(stale.props.children)).toHaveLength(0);
  expect(chosen).toEqual([["codex-offer-1", "accept"], ["codex-offer-1", "decline"]]);
});

test("the Gemini permission subview forwards the offered option identity unchanged", () => {
  const chosen: Array<[string, string]> = [];
  const current = InboxPermissionChoices({
    label: "Gemini permission decisions",
    offerId: "gemini-offer-1",
    choices: [
      { value: "read_once", label: "Allow once" },
      { value: "reject_once", label: "Deny" },
    ],
    disabled: false,
    onChoose: (offerId, value) => chosen.push([offerId, value]),
  });
  expect(current.props["aria-label"]).toBe("Gemini permission decisions");
  expect(toChildArray(current.props.children)).toHaveLength(2);
  clickChoice(current, 0);
  expect(chosen).toEqual([["gemini-offer-1", "read_once"]]);
});
