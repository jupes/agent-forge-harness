import { type ComponentChild, h, render } from "preact";

const mounted = new WeakSet<HTMLElement>();

/** Hidden node used only to exercise mount/unmount in dev self-test. */
function BridgeSelfTestSpan() {
  return h("span", {
    "data-agent-forge-bridge-self-test": "1",
    "aria-hidden": "true",
    style: { display: "none" },
  });
}

/** VNode for a no-op island used to validate the bridge wiring. */
export function createBridgeSelfTestVNode(): ComponentChild {
  return h(BridgeSelfTestSpan, {});
}

/**
 * Mount a Preact tree into `container`, replacing any prior content.
 * Callers should use stable container elements (one island per container).
 */
export function mountIsland(
  container: HTMLElement,
  vnode: ComponentChild,
): void {
  if (mounted.has(container)) {
    unmountIsland(container);
  } else {
    // Preact diffs the new tree against existing `firstChild`; any extra placeholder
    // siblings (e.g. a static "Loading…" in HTML) would stay at the end of the
    // container. Clear the container so the island is the only content.
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
  }
  render(vnode, container);
  mounted.add(container);
}

/** Remove a Preact tree from `container` and clear the DOM node. */
export function unmountIsland(container: HTMLElement): void {
  if (!mounted.has(container)) return;
  render(null, container);
  mounted.delete(container);
}
