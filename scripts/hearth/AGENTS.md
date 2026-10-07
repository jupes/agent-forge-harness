# AGENTS.md — scripts\hearth

The hearth: the standalone loopback control-plane server (`bun run hearth`) and its Vite integration.

## Scope

- Applies to this directory and descendants unless a deeper `AGENTS.md` overrides it.
- Parent guidance still applies unless this file states a stricter override.

## Local Rules

- Every request passes `gate.ts` (`frontDoorOrigin`) before routing: loopback peer, loopback `Host`, `Origin` equal to the host origin, no cross-site fetch metadata. Do not add a route that skips it.
- Handlers in `routes/` keep the `(req, res, next)` shape and the `{ ok, data, error }` envelope; their tests mount them on their own `node:http` server.
- State lives in `AGENT_FORGE_HOME` (default `~/.agent-forge`): `hearth-<hash(root)>.lock` and `tokens/<hash(root)>.token`. Tests must pass a temp `home`; never touch the real one.
- A hearth serves exactly one root. A dashboard reuses a live hearth only when the lock's root matches.
- The token is created and served here; enforcing it on mutating routes is the operator API's job.
- Under Vite the peer is always the dev server, so the loopback check for proxied traffic is `guardRequest` in `vite-plugin.ts`. Keep it failing closed.
- Spawn the hearth as `bun scripts/hearth/server.ts`, never through `bun run`, so the pid in the lock is the server's.

## Notes

- Tests: `bun test scripts/hearth`. `supervisor.test.ts` starts real `bun` child processes.
- `loadDashboardServerEnvironment` pulls in `vite`; a compiled sidecar will need an env loader without it.
