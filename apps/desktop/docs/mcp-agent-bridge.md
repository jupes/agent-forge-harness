# Agent-only MCP bridge source

The compiled Hearth entry includes an isolated `--mcp-stdio` mode. Its only
selectors are one absolute `--root` and one absolute `--home`, in either order.
Missing, duplicate, relative, oversized, newline/NUL or unknown input is refused
before loading the MCP, Council or ledger implementations. `--operator` is never
accepted by this mode. It does not start, listen, claim a Hearth or initialize
its home; it connects as an agent to an already owned Hearth when tools are used.

The normal packaged entry supplies a private prefix using its own executable.
The source entry supplies its absolute Bun executable and source entry path.
These prefixes are host composition data, not renderer commands or PATH-based
client choices. Settings registration must append trusted connected selectors;
this source mode does not itself read or write any client's configuration.

Forge reads bind the explicit root and home. Council binds its harness and
workspace to that root, its default run directory to `reports/council-runs` below
that root, and its private review home and ledger file to the selected home.
It takes no ambient client session, bead, workspace or Council-run-directory
override. Registration for a Hearth using a different Council namespace needs
an explicit compatible producer contract; this default binding does not prove it.

Governed Forge and Council tools remain denied before arguments, token lookup
or effects. The identity-neutral ledger callbacks do not grant operator authority.
The legacy source `hearth:mcp --operator` contract is separate and unchanged;
this packaged agent mode never selects it or copies an operator token.

Standard output belongs only to the existing MCP protocol. This mode selects
fixed generic readiness, startup-failure and protocol-error diagnostics on
standard error, without root paths, error bodies or getter evaluation. Legacy
CLI diagnostics keep their existing behavior. Existing stdin retirement and
MCP transport handling are reused; this adds no provider process or extra Hearth.

Focused parser, namespace, diagnostic and in-memory MCP tests use fake selectors
and temporary roots. They verify governed denial without token reads or network
exchange and that an absent home stays absent. They do not qualify a compiled
binary, installed asset, real client's trust/approval/connection, native cleanup
or human acceptance. No native app, installer or client was launched for them.

agent-forge-harness-cla5.8.1.11.1 (agent-only stdio producer source) is a prerequisite
of agent-forge-harness-cla5.8.1.11 (Settings client registration). Default target
discovery, bounded byte-preserving client writers, durable original/receipt
recovery and the Settings controls remain required. The broader integration and
native/package/human owners stay open; this file grants no new runtime attempt.
