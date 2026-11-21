---
name: ui-screenshot
description: Capture verified desktop and mobile UI screenshots for review or a PR. Use when visual evidence of changed pages is needed.
---

# Capture UI evidence

1. Resolve the target app, changed routes, and comparison base from the request and
   Git tracking configuration. Inspect its manifest for the actual server command.
2. Reuse a running app or start its documented development server with a bounded
   readiness check. Use the available browser tool or repository Playwright setup.
   Report unavailable tooling or startup failure instead of claiming captures.
3. Map the changed UI to representative states. Capture desktop and mobile sizes
   appropriate to the app (1280 and 375 CSS pixels are useful defaults). Exercise
   relevant loading, empty, error, and populated states when the change affects them.
4. Save under `.tmp/screenshots/` and inspect each image for loaded content, clipping,
   readable labels, and unintended private data. Record route, viewport, and state.
5. Link local captures for review. For an authorized PR update, use accessible image
   URLs only after a supported attachment/upload succeeds; local paths do not render
   for GitHub readers. If upload is unavailable, report that limitation.

Complete when captures exist, have been visually inspected, and the response
accurately distinguishes local evidence from images actually attached to a PR.
Stop only the development server this session started.
