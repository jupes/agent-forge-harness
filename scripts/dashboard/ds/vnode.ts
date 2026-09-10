/**
 * Vnode-walk helpers for design-system component tests.
 *
 * Preact components are plain functions returning a VNode tree, so a test can
 * call one directly and assert on the structure it produced — no DOM, no
 * jsdom/happy-dom, no testing-library. This mirrors the pattern already used by
 * `scripts/council/ui-components.test.ts`, lifted here so every `docs/js/ds/`
 * test shares one copy.
 *
 * These assert *structure* (elements, props, ARIA). Computed styles, focus
 * rings, layout and console errors are invisible at this layer and belong to
 * the Playwright suite in `tests/e2e/` instead.
 */

import { type ComponentChildren, isValidElement, type VNode } from "preact";

export type AnyVNode = VNode<Record<string, unknown>>;

/** The node itself plus every descendant, depth-first. */
export function nodesOf(value: ComponentChildren): AnyVNode[] {
  if (Array.isArray(value)) return value.flatMap(nodesOf);
  if (!isValidElement(value)) return [];
  const node = value as AnyVNode;
  return [node, ...nodesOf(node.props["children"] as ComponentChildren)];
}

/** Intrinsic element name (`"button"`), or the component's function name. */
export function tag(value: ComponentChildren): string {
  if (!isValidElement(value)) return "";
  const type = (value as AnyVNode).type;
  return typeof type === "string" ? type : (type?.name ?? "");
}

/** Props of a vnode, as a plain record. */
export function attrs(value: ComponentChildren): Record<string, unknown> {
  if (!isValidElement(value)) return {};
  return (value as AnyVNode).props;
}

/** Concatenated visible text of a subtree. */
export function textOf(value: ComponentChildren): string {
  if (Array.isArray(value)) return value.map(textOf).join("");
  if (isValidElement(value)) {
    return textOf((value as AnyVNode).props["children"] as ComponentChildren);
  }
  if (value === null || value === undefined || typeof value === "boolean") {
    return "";
  }
  return String(value);
}

/** Every node in the subtree whose tag/component name matches. */
export function findAll(value: ComponentChildren, name: string): AnyVNode[] {
  return nodesOf(value).filter((node) => tag(node) === name);
}

/** First node in the subtree matching a predicate over its props. */
export function findWhere(
  value: ComponentChildren,
  predicate: (props: Record<string, unknown>, node: AnyVNode) => boolean,
): AnyVNode | undefined {
  return nodesOf(value).find((node) => predicate(node.props, node));
}
