# Smiths verification task inspection

Smiths can open the apprentice verification task from the tracker served by the connected hearth without assigning it to a project. The modal reports the recorded title, status, priority, description, acceptance criteria, notes, update time, served workspace and check time. A tracker status does not certify live provider, model or effort support.

The only new endpoint is the protected `GET /smiths/verification`. It accepts no parameters and runs the fixed `--readonly show agent-forge-harness-cla5.6.6.1 --json` argument array. The response must contain exactly that one task. Its raw answer and returned projection are each bounded to 256 KiB, and the injected runner has a separate deadline. Unknown raw fields are excluded. Failed, malformed, foreign, oversized and incomplete answers report unavailable.

The modal starts a read only when explicitly opened. Close and navigation abort and fence the observer; a late answer cannot reopen it or cross served workspaces. Retry performs a fresh protected read. Supplied prose is rendered as inert text. This feature has no write endpoint, provider start, model change, or project membership side effect.

Focused route, client, receiving-boundary and view tests cover the fixed identity, protection, bounded failure, priority zero, stale responses and inert text. At `eb2735f`, all five actual isolated-hearth Smiths journeys passed in20.5 seconds, including both new verification cases: keyboard2px focus,1100×700 reduced-motion layout, current tracker facts, genuine retry, close/navigation and read-only preservation. Source and HEAD stayed unchanged and both listeners stopped. The neutral modal screenshot was visually inspected. Full/native/hosted acceptance remains pending.
