# AGENTS.md — scripts\hearth

The hearth: the standalone loopback control-plane server (`bun run hearth`) and its Vite integration.

## Scope

- Applies to this directory and descendants unless a deeper `AGENTS.md` overrides it.
- Parent guidance still applies unless this file states a stricter override.

## Local Rules

- Every request passes `gate.ts` (`frontDoorOrigin`) before routing: loopback peer, loopback `Host`, `Origin` equal to the host origin, no cross-site fetch metadata. Do not add a route that skips it.
- The operator API is one table: `api.ts` is the runner; `routes/operator.ts` assembles the table and holds the actions and the stream row; `routes/operator-reads.ts` holds the read rows; `routes/beads.ts` holds the tracker writes and the options row. A new route is a new row. Never check the origin, the token or the audit row inside a row, and never answer JSON from one: the runner does all of it, for every row, in one order (same-origin, token, body, validation, `operator.action`, effect).
- Every mutation is an action row. `routes/council.ts` and `routes/dev-api.ts` only read; do not add a POST branch to either. Their tests mount them on their own `node:http` server; an action row is tested through a hearth (`testing.ts` gives a hermetic one), and `api.test.ts` iterates the table: a row with no fixture there fails the suite.
- Handlers in `routes/` keep the `(req, res, next)` shape and the `{ ok, data, error }` envelope.
- State lives in `AGENT_FORGE_HOME` (default `~/.agent-forge`): `hearth-<hash(root)>.lock` and `tokens/<hash(root)>.token`. Tests must pass a temp `home`; never touch the real one. The event ledger lives in the same directory (`ledger.db`, `backups/`, `hook-probe.jsonl`); `scripts/agent-forge-home.ts` resolves it for both, and an `AGENT_FORGE_HOME` that is empty or only whitespace counts as unset.
- `vite-plugin.ts` and what it imports (`supervisor.ts`, `lock.ts`, `home.ts`, `gate.ts`, `paths.ts`) are loaded by Vite under Node: no `bun:` module and nothing from `scripts/ledger/` there. `server.ts`, `api.ts`, `stream.ts` and `routes/` run only under Bun, and `server.ts` and the two `routes/operator*.ts` modules import the ledger. `paths.ts` is also bundled for the browser (`docs/js/operator.ts`): constants only.
- Council runs started through the hearth are recorded only when `createHearth` is handed `councilLedger`. `main()` hands it `operatorCouncilLedger()` (loaded by a dynamic import); tests hand it nothing and record nothing. That builder attributes a run to the workspace and the bead the request named and infers nothing: the operator started it, not the agent session whose mirror file is in the checkout.
- A hearth serves exactly one root. A dashboard reuses a live hearth only when the lock's root matches.
- The token is minted at start and enforced by the runner on every action row. It is honoured only while the file the lock names still holds it; the token route answers 503 whenever no token could be honoured.
- Under Bun's `node:http`: a header sent twice arrives as its last value (only `rawHeaders` shows the repeat, which is why the runner counts there); a client that disconnects closes the request and the socket but not the response (which is why `stream.ts` listens to all three); response headers are not sent until the first write unless `flushHeaders()` is called; `res.write` returns true however much is waiting, so `res.writableLength` is what `stream.ts` reads for backpressure; `drain` can fire inside a `write`, before the caller's next line, so the stream's pump refuses to be re-entered; ending a response to a client that is not reading frees nothing until that client leaves, so a stalled stream's socket is destroyed instead; and leaving `for await (const chunk of req)` early makes the runtime end the response itself with an empty 200, so the body reader drains what it refuses.
- `bd` is never run synchronously here. `bdRunner` is asynchronous, takes an argument array and no shell; the queue read is always the same argument array (`QUEUE_LIST_ARGS`), one at a time, with its own 15 s limit passed to the runner; every other call has the runner's 30 s.
- A write to the tracker (`routes/beads.ts`) is one `bd` call, never repeated, never with `--repo`. Build its arguments so that nothing a caller sent can be read as an option: every value as `--flag=value`, every positional after `--` (`bd comments add <id> --help` prints help, exits 0 and adds nothing), an id always present (`bd close` with none closes the last touched issue) and checked with `parseBeadsIssueId`. A description of exactly `-` is refused: `bd` reads it from standard input, and `bdRunner` leaves stdin open, so the call would wait for the runner's limit.
- Exit 0 from `bd` is not success. Confirm a write by what `bd` printed, take the id it printed as the bead that was written, and only then append `bead.transitioned`. Answer `502` when `bd` refused (with its own error line: with `--json` some commands print it on stdout, and the runner's `Command failed: bd …` line on stderr repeats every argument, so never pass that on), `504` when the outcome is not known (a killed `bd create` still creates the issue), `409` for an issue that was already closed, and never `403` from an effect: the page posts an action again after a 403.
- `bd-answers.ts` is what `bd` prints for a write, in one place: `testing.ts`, the browser suite's stand-in and the route tests all build their answers from it. Change it there, and check a change against a real `bd`.
- Under Vite the peer is always the dev server, so the loopback check for proxied traffic is `guardRequest` in `vite-plugin.ts`. Keep it failing closed.
- Spawn the hearth as `bun scripts/hearth/server.ts`, never through `bun run`, so the pid in the lock is the server's.

## Notes

- Tests: `bun test scripts/hearth`. `supervisor.test.ts` and `api-spawned.test.ts` start real `bun` child processes.
- A temp root used as a hearth root in a test needs a planted `.git`: the OS temp directory can sit inside a checkout, and the ledger's workspace would otherwise be that checkout.
- `loadDashboardServerEnvironment` pulls in `vite`; a compiled sidecar will need an env loader without it.
