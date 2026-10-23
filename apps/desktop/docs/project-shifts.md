# Project shift boundary

Bead: agent-forge-harness-cla5.5.4.1. Parent: cla5.5.4. Source: versioned desktop handoff 7e41bba and brief section 6.10. The settled handoff requires attended runs with every turn visible; the legacy autonomous CLI is not sufficient proof of that capability.

## Chosen interface

The selected interface is a protected project facade over the existing shift engine. Options, original-request lookup and observations are reads; Start, Stop and Recover remain separate audited operator actions. `runOptions`, `shiftOptions`, `createShiftStarts`, `runShift`, `requestStop` and `recoverShift` retain their rules.

An in-process controller could own the scheduler and provider sessions together, but would replace the launcher's process ownership and close/recovery behavior. A two-phase prepared ticket could freeze reviewed defaults before Commit, but would add ticket expiration and another authorization lifecycle. The facade needs fewer concepts while retaining explicit human Start and the existing cleanup machinery.

## Options read

`GET /projects/:id/shifts/options` is operator-only. It validates the served workspace and the current selected epic ancestry **and** `project:<slug>` label before exposing choices. Each configured bound includes its actual configuration source. Base retains the shift CLI default. An omitted per-run timeout means the remaining shift time, because the scheduler explicitly passes that remaining duration to each attempt; it does not mean the standalone executor's 30-minute default.

This read neither reserves a launch nor runs a provider. Start availability remains false until the attended private transcript adapter is implemented and verified. The refusal exists at the server boundary; a disabled renderer control is not authorization.

## Admission and recovery contract

The next producer preserves the full reviewed bounds with a request UUID, request hash, canonical workspace, project and server-selected shift id in bounded private storage before the single launch attempt. Exact original-request reads remain available independently of mutable provider configuration. A lost or interrupted launch never starts again during GET or an exact retry.

New admission must recheck current catalog revision, archive state, selected epic ancestry and project label inside the canonical queue ownership boundary. Stop and Recover use the immutable original project/workspace binding, so an archived project cannot strand an already-owned run. Stop requests cancellation; only the observed terminal record after supervised child exit confirms that the shift stopped. Recovery retains the canonical ownership checks, live-pid refusal and partial-progress behavior.

The packaged launcher needs an explicit compiled shift entry rather than invoking a source path with the compiled hearth executable. Attended execution additionally needs bounded private capture of the actual provider turns from the executor path and links to their owner-only journals. Raw output, prompts and provider error prose never enter ledger metadata. Until those producers exist, the parent feature remains incomplete.

## Verification

The first tracer verifies exact configured defaults and provenance, scoped epic choices, a protected real-hearth options read and absence of launches, durable reservations and tracker writes. Subsequent admission tests cover audit ordering, immutable original requests, crash boundaries, fresh per-admission scope and workspace fences. Packaged fake-provider and browser evidence must prove visible private turns, cancellation and recovery before the parent is complete. No fixture uses a real provider, tracker or remote repository.
