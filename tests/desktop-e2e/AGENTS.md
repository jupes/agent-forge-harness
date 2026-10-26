# Desktop browser tests

Follow ../e2e/AGENTS.md. This suite reuses its isolated hearth, stand-in CLIs,
launch/session exchange and teardown, with Vite's desktop mode. Run with
`bun run verify:desktop`. Fixture catalogs contain no user data and are written
only inside that run's HEARTH_HOME. Native behavior still requires desktop:smoke.

CI runs this suite across the same three isolated matrix jobs with Playwright's
`--shard=1/3`, `2/3` and `3/3` selectors. Keep it serial within each job. When
changing the suite or its assignment, compare the unsharded list with all three
shard lists and verify their union has no missing or duplicate test identities.
The separate worktree, attended Shift and owned-restart suites remain complete
selectors on shard 1.
