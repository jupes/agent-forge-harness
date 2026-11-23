/**
 * A stand-in for `git`, for the browser suite and nothing else.
 *
 * The suite's hearth runs with a PATH that holds only the stand-ins'
 * directory. A council run on a bead asks `git worktree list --porcelain -z`
 * whenever the checkout's repository has a linked worktree (x1gs.7.5): with no
 * `git` on that PATH the listing failed, the pack carried the note
 * "worktrees: not searched, git could not list them", and the council specs
 * failed on a developer machine with worktrees while CI, whose fresh clone has
 * none, never asked (x1gs.7.14). The real `git` would search the developer's
 * own worktrees, so the suite's packs would depend on the machine.
 *
 * Global setup compiles this file to a program named `git` beside the `bd`
 * stand-in. It answers that one listing as git does, naming the directory it
 * runs in as the repository's only worktree, so the bead source runs its
 * listing, parses it and finds nothing more to search, the same on every
 * machine. Anything else exits 1 with a line on stderr, which every caller in
 * the hearth already treats as git failing.
 */

const args = process.argv.slice(2);
const here = process.cwd().replaceAll("\\", "/");

// The coding-session scope validator needs the fixture's ordinary checkout
// discovery as well as its listing. These are synthetic cwd-only answers;
// no ambient Git process, repository config, hooks or other checkout is read.
if (args.join(" ") === "rev-parse --show-toplevel") {
  process.stdout.write(`${here}\n`);
  process.exit(0);
}
if (args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
  process.stdout.write(`${here}/.git\n`);
  process.exit(0);
}

if (args.join(" ") === "worktree list --porcelain -z") {
  process.stdout.write(
    `worktree ${here}\0HEAD ${"0".repeat(40)}\0detached\0\0`,
  );
  process.exit(0);
}

process.stderr.write(
  `git stand-in: "git ${args.slice(0, 2).join(" ")}" is not arranged in the browser suite\n`,
);
process.exit(1);
