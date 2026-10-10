# AGENTS.md — scripts\hearth

The hearth: the standalone loopback control-plane server (`bun run hearth`) and its Vite integration.

## Scope

- Applies to this directory and descendants unless a deeper `AGENTS.md` overrides it.
- Parent guidance still applies unless this file states a stricter override.

## Local Rules

- Every request passes `gate.ts` (`frontDoorOrigin`) before routing: loopback peer, loopback `Host`, `Origin` equal to the host origin, no cross-site fetch metadata. Do not add a route that skips it.
- The operator API is one table: `api.ts` is the runner; `routes/operator.ts` assembles the table and holds the actions and the stream row; `routes/operator-reads.ts` holds the read rows. A new route is a new row. Never check the origin, the token or the audit row inside a row, and never answer JSON from one: the runner does all of it, for every row, in one order (same-origin, token, body, validation, `operator.action`, effect).
- Every mutation is an action row. `routes/council.ts` and `routes/dev-api.ts` only read; do not add a POST branch to either. Their tests mount them on their own `node:http` server; an action row is tested through a hearth (`testing.ts` gives a hermetic one), and `api.test.ts` iterates the table: a row with no fixture there fails the suite.
- Handlers in `routes/` keep the `(req, res, next)` shape and the `{ ok, data, error }` envelope.
- State lives in `AGENT_FORGE_HOME` (default `~/.agent-forge`): `hearth-<hash(root)>.lock` and `tokens/<hash(root)>.token`. Tests must pass a temp `home`; never touch the real one. The event ledger lives in the same directory (`ledger.db`, `backups/`, `hook-probe.jsonl`); `scripts/agent-forge-home.ts` resolves it for both, and an `AGENT_FORGE_HOME` that is empty or only whitespace counts as unset.
- `vite-plugin.ts` and what it imports (`supervisor.ts`, `lock.ts`, `home.ts`, `gate.ts`, `paths.ts`) are loaded by Vite under Node: no `bun:` module and nothing from `scripts/ledger/` there. `server.ts`, `api.ts`, `stream.ts` and `routes/` run only under Bun, and `server.ts` and the two `routes/operator*.ts` modules import the ledger. `paths.ts` is also bundled for the browser (`docs/js/operator.ts`): constants only.
- Council runs started through the hearth are recorded only when `createHearth` is handed `councilLedger`. `main()` hands it `operatorCouncilLedger()` (loaded by a dynamic import); tests hand it nothing and record nothing. That builder attributes a run to the workspace and the bead the request named and infers nothing: the operator started it, not the agent session whose mirror file is in the checkout. A request whose source is a bead names that bead: the council route takes the bead for its audit row and for the service from `councilBeadId`, after `assertCouncilInput` has refused a `beadId` that is another bead.
- A hearth serves exactly one root. A dashboard reuses a live hearth only when the lock's root matches.
- The token is minted at start and enforced by the runner on every action row. It is honoured only while the file the lock names still holds it; the token route answers 503 whenever no token could be honoured.
- Under Bun's `node:http`: a header sent twice arrives as its last value (only `rawHeaders` shows the repeat, which is why the runner counts there); a client that disconnects closes the request and the socket but not the response (which is why `stream.ts` listens to all three); response headers are not sent until the first write unless `flushHeaders()` is called; `res.write` returns true however much is waiting, so `res.writableLength` is what `stream.ts` reads for backpressure; `drain` can fire inside a `write`, before the caller's next line, so the stream's pump refuses to be re-entered; ending a response to a client that is not reading frees nothing until that client leaves, so a stalled stream's socket is destroyed instead; and leaving `for await (const chunk of req)` early makes the runtime end the response itself with an empty 200, so the body reader drains what it refuses.
- `bd` is never run synchronously here. `bdRunner` is asynchronous, takes an argument array and no shell; the queue read is always the same argument array (`QUEUE_LIST_ARGS`), one at a time, with its own 15 s limit passed to the runner; every other call has the runner's 30 s.
- Under Vite the peer is always the dev server, so the loopback check for proxied traffic is `guardRequest` in `vite-plugin.ts`. Keep it failing closed.
- Spawn the hearth as `bun scripts/hearth/server.ts`, never through `bun run`, so the pid in the lock is the server's.

## Notes

- Tests: `bun test scripts/hearth`. `supervisor.test.ts` and `api-spawned.test.ts` start real `bun` child processes.
- A temp root used as a hearth root in a test needs a planted `.git`: the OS temp directory can sit inside a checkout, and the ledger's workspace would otherwise be that checkout.
- `loadDashboardServerEnvironment` pulls in `vite`; a compiled sidecar will need an env loader without it.
