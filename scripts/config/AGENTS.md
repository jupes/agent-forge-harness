# AGENTS.md — scripts/config

Layered config (`agent-forge.toml`) for smiths, benches and the executor env allowlist.

- `load.ts` is the only reader; precedence and the never-inherit rule for `execution.env.pass` live there.
- Parsing uses `Bun.TOML` (no dependency). It is lenient on some malformed input; validate shapes, not syntax.
- Keep provenance on every value — `forge:config show` is the audit surface.
- Smith/bench names and shapes come from `types/hearth.ts`; do not redefine them here.
