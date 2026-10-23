/** Real Git forwarding only inside this run's fresh temporary repository. */
import { spawnSync } from "node:child_process";
import { appendFileSync, lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { checkedFixtureRoot, fixturePlan, gitEnvironment } from "./environment";

function refuse(): never {
  process.stderr.write(
    "Dedicated Git fixture refused an unowned directory or unsupported command.\n",
  );
  process.exit(1);
}
checkedFixtureRoot();
const plan = fixturePlan(),
  cwd = realpathSync.native(process.cwd()),
  root = realpathSync.native(plan.root),
  args = process.argv.slice(2);
const slash = (value: string) => value.replaceAll("\\", "/").toLowerCase();
if (
  slash(root) !== slash(join(checkedFixtureRoot(), "repository")) ||
  lstatSync(plan.root).isSymbolicLink() ||
  slash(realpathSync.native(plan.emptyHome)) !==
    slash(join(checkedFixtureRoot(), "empty-home"))
)
  refuse();
const owned =
  slash(cwd) === slash(root) ||
  /^trees\/sw-[a-f0-9]{28}$/.test(slash(relative(root, cwd)));
if (
  !owned ||
  lstatSync(cwd).isSymbolicLink() ||
  slash(realpathSync.native(dirname(plan.calls))) !==
    slash(checkedFixtureRoot())
)
  refuse();
const branch = (value: string | undefined) =>
  !!value &&
  /^feat\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(value) &&
  !value.includes("..") &&
  !value.startsWith("-");
const words = args.join(" ");
let allowed = [
  "rev-parse --show-toplevel",
  "rev-parse --path-format=absolute --git-common-dir",
  "rev-parse HEAD",
  "worktree list --porcelain -z",
].includes(words);
if (
  args.length === 3 &&
  args[0] === "check-ref-format" &&
  args[1] === "--branch" &&
  branch(args[2])
)
  allowed = true;
if (
  args.length === 4 &&
  words.startsWith("rev-parse --verify --quiet ") &&
  (args[3] === "HEAD^{commit}" ||
    args[3] === `${plan.base}^{commit}` ||
    (args[3]?.startsWith("refs/heads/") && branch(args[3].slice(11))))
)
  allowed = true;
if (
  args.length === 4 &&
  args[0] === "check-ignore" &&
  args[1] === "-v" &&
  args[2] === "--" &&
  /^trees\/sw-[a-f0-9]{28}$/.test(args[3] ?? "")
)
  allowed = true;
if (
  args.length === 7 &&
  args[0] === "worktree" &&
  args[1] === "add" &&
  args[2] === "-b" &&
  branch(args[3]) &&
  args[4] === "--" &&
  slash(cwd) === slash(root) &&
  /^trees\/sw-[a-f0-9]{28}$/.test(
    slash(relative(root, resolve(args[5] ?? ""))),
  ) &&
  args[6] === plan.base
)
  allowed = true;
if (!allowed) refuse();
appendFileSync(plan.calls, JSON.stringify({ cwd, args }) + "\n");
const result = spawnSync(
  plan.git,
  [
    "-c",
    `core.hooksPath=${join(plan.emptyHome, "hooks")}`,
    "-c",
    "protocol.file.allow=never",
    "-c",
    "core.autocrlf=false",
    ...args,
  ],
  {
    cwd,
    env: gitEnvironment(),
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1_048_576,
  },
);
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exit(result.status ?? 1);
