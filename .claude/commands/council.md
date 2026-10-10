# /council — Deliberative multi-provider review

Review a PR, plan, research document, Beads issue, or supplied text using the shared council engine.

## Usage

```
/council pr <number-or-url> --profile councils/multi-provider.example.json
/council plan <path> --profile councils/my-council.json
/council file <research.md> --profile councils/my-council.json
/council bead <beads-issue-id> --profile councils/my-council.json
```

1. Resolve the user's artifact and intended scope. Include relevant acceptance criteria and supporting code/document excerpts; council models do not browse or inspect the repository independently.
2. Run `bun run council -- <source-kind> <source> --profile <profile> --dry-run --json`. Check the envelope's `ok`, readiness, truncation, and budget. Never print or request API keys in chat. Without a hosted profile, explain that the default profile is only a deterministic demo.
3. Run the same command without `--dry-run`, with the user's budget when supplied. This sends the source to every selected provider. Do not change providers or expand disclosure beyond the user's chosen profile.
4. Read the returned `run`, including limitations, failures, unreviewed or contested findings, and reviewer rationales. An unsuccessful envelope may still contain a preserved run and artifacts; report them.
5. Present the chair's recommendation with evidence and disagreements. A council verdict is advisory, not permission to edit, approve, merge, or post a GitHub review.

## A bead as the source

`/council bead <id>` packs one Beads issue: its acceptance criteria (with id, title, type, priority, status, labels and dependency ids), its latest comments newest first, its description, the plan, research and report of its forge run or that it names, and the most recently mentioned pull request of this workspace's own origin repository. The evidence budget is spent in that order. The acceptance criteria and the comments take what they need first; the description is held to a tenth of the budget and each linked file to 15% until the pull request has had its turn, so under a short budget a long plan can be cut while the pull request is still packed.

- **Only when the user names the bead.** Bead content is private, and a council run sends it to every provider in the profile. Never pick a bead yourself, and never widen a review to a bead the user did not name.
- **Give the full id.** A partial id is refused. The bead is read with `bd --readonly`; nothing is written to the tracker.
- **Read the listing before sending.** The `--dry-run` envelope's `data.context.listing` has one line per part: packed, cut, left out, missing, or a pull request URL that was not fetched. Show it to the user with the profile's providers and get their go-ahead before step 3. A real run prints the same listing on stderr before it starts.
- A credential-like value in anything that would be sent or listed (the bead's title, labels, criteria, description, design, notes, external reference, spec id, comments, a linked file, the pull request) refuses the run and names where. That includes a part the budget would have dropped. Tell the user where; do not reach for `--redact-secrets` on your own.
- Any plan, research or report path the bead mentions is sent, even when it was written for another bead. The listing shows each one: check it.
- A run of a bead is recorded in the ledger against that bead, whether it was started with this command, through the MCP server or through the hearth's council route, and whether or not the caller also named the bead for the ledger. Naming a different bead for the ledger is refused. The dashboard's council page does not offer a bead as a source.

For interactive use: `bun run dashboard`, then `/council.html`. For another agent or system, prefer MCP `council_start` followed by `council_status`, avoiding a long blocking tool request. See `docs/COUNCIL-REVIEWS.md`.
