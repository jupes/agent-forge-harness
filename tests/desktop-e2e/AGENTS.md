# Desktop browser tests

Follow ../e2e/AGENTS.md. This suite reuses its isolated hearth, stand-in CLIs,
launch/session exchange and teardown, with Vite's desktop mode. Run with
`bun run verify:desktop`. Fixture catalogs contain no user data and are written
only inside that run's HEARTH_HOME. Native behavior still requires desktop:smoke.
