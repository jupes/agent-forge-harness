# AGENTS.md — scripts/config

Layered config (`agent-forge.toml`) for smiths, benches and the executor env allowlist.

- `load.ts` is the only reader; precedence and the never-inherit rule for `execution.env.pass` live there.
- The machine (user) file is `config.toml` in the Agent Forge home (`machineConfigFile`, through `scripts/agent-forge-home.ts`): `AGENT_FORGE_HOME`, else `~/.agent-forge`, read from the process environment as the OS home is. `LoadOptions.env` does not move it: `forge:exec` passes the environment it hands its child there. An explicit `home` (an OS-home stand-in) still wins. A file read from a moved home is still the user layer, so its `execution.env.pass` never applies once a workspace file exists.
- Parsing uses `Bun.TOML` (no dependency). It is lenient on some malformed input; validate shapes, not syntax.
- Keep provenance on every value — `forge:config show` is the audit surface.
- Smith/bench names and shapes come from `types/hearth.ts`; do not redefine them here.
- A name someone typed (a smith, a bench, a smith field, a `get` key) is looked up as an own key (`Object.hasOwn`): `constructor`, `__proto__` and `toString` are keys of every object, so a plain index reads them as present. A smith cannot be named after one: `loadConfig` refuses the table and `set` refuses the key.
- `write.ts` is the only writer (`forge:config set <key> <value> --user|--workspace`). It edits one line in place and keeps everything else: comments, order, a byte-order mark and CRLF line endings. It refuses any file with a line it does not fully read (a dotted key, an inline table, a multi-line string, `[[array]]`), and checks every edit twice before writing: the file must parse to what it held with only that key changed, and `loadConfig` must accept it (through `LoadOptions.contents`). Keep both checks: the deep compare is a second line of defence that no test reaches today.
- `keys` lists the keys `set` writes (`settableKeys`): every field of every loaded smith, not just the ones a file sets. A new smith is added by hand, because provider, model and effort have to arrive together.
- Writing the workspace file for the first time stops the user file's `execution.env.pass` applying, so `set` refuses to do that as a side effect. Setting `execution.env.pass` itself is allowed, and says which user values it replaces.
- The write replaces the file through a rename: a config file that is a symlink becomes a regular file, and its permission bits are those a new file gets. Edit a symlinked config by hand.
