import { lstatSync, opendirSync, type Stats } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { ProjectRecord } from "../../types/projects";
import { readHomeFile } from "../hearth/home-guard";
import { readAllRestartIdentityInventory } from "../identities/restart-index";
import { readReservationInventory } from "../ledger/reservation-inventory";
import { resolveCheckout } from "../ledger/workspace";
import {
  type GitRun,
  gitRun,
  parsePorcelainZ,
  readStrictWorktreeRegistry,
  registryPathKey,
  worktreeInspectionRefusal,
} from "../scheduler/worktrees";
import { createSessionRegistry } from "../sessions/registry";
import { observeProjectShift } from "../shifts/observations";
import { createProjectShiftRegistry } from "../shifts/registry";
import { readProjectShiftEvidence } from "../shifts/service";
import { canonicalTrustedDirectory } from "../trusted-directory";
import { readProjectActivityInventory } from "./lifecycle-inventory";
import { selectProjectBeads, workspaceKey } from "./scope";
import { createProjectStore } from "./store";
import type { ProjectSources } from "./summary";

interface Options {
  home: string;
  root: string;
  projectId: string;
  worktreeId: string;
}
interface Dependencies {
  git?: GitRun;
  readSources(
    project: ProjectRecord,
    root: string,
  ): ProjectSources | Promise<ProjectSources>;
}
/** Advisory snapshot only. A later audited effect must independently recheck under its fences. */
export async function readWorktreeCleanupPreflight(
  options: Options,
  deps: Dependencies,
) {
  const root = resolveCheckout(options.root).workspace;
  const refused = (reason: string) => ({
    state: "refused" as const,
    reasons: [reason],
  });
  try {
    const catalog = createProjectStore(options.home).read(),
      project = catalog.projects.find((row) => row.id === options.projectId),
      registry = readStrictWorktreeRegistry(root);
    if (
      !project ||
      !project.workspaces.some(
        (scope) =>
          workspaceKey(scope.root) === workspaceKey(root) &&
          scope.repositories.some(
            (path) => registryPathKey(path) === registryPathKey(root),
          ),
      )
    )
      return refused("The project does not include the served repository.");
    if (!registry.ok) throw Error("Unknown registry");
    const row = registry.value.find((item) => item.id === options.worktreeId);
    if (!row) return refused("The worktree is not owned by this registry.");
    if (row.ownerSessionId !== undefined || row.beadId === undefined)
      return refused(
        "Session-owned and legacy worktrees are outside guarded Shift cleanup.",
      );
    try {
      lstatSync(join(row.path, ".agent-forge-session"));
      return refused("A session mirror is present; its worktree is retained.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const directories = [root, join(root, "trees"), row.path];
    const pins = () =>
      directories.map((path) => {
        if (
          registryPathKey(canonicalTrustedDirectory(path)) !==
          registryPathKey(path)
        )
          throw Error("Noncanonical target");
        const info = lstatSync(path);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw Error("Unsafe target");
        return `${info.dev}:${info.ino}`;
      });
    const identities = pins();
    const git = (args: string[], cwd = root) =>
      (deps.git ?? gitRun)(
        [
          "--no-optional-locks",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.untrackedCache=false",
          ...args,
        ],
        cwd,
        5000,
      );
    const verified = (args: string[], cwd = root) => {
      const result = git(args, cwd);
      if (result.status !== 0 || result.stdout.length > 1024 * 1024)
        throw Error("Incomplete Git read");
      return result.stdout;
    };
    for (const path of [root, row.path]) {
      if (
        registryPathKey(
          verified(["rev-parse", "--show-toplevel"], path).trim(),
        ) !== registryPathKey(path) ||
        registryPathKey(
          verified(
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            path,
          ).trim(),
        ) !== registryPathKey(join(root, ".git"))
      )
        return refused(
          "Git does not confirm this repository and worktree family.",
        );
    }
    const listed = verified(["worktree", "list", "--porcelain", "-z"]);
    if (!listed.endsWith("\0")) throw Error("Incomplete Git listing");
    const matches = parsePorcelainZ(listed).filter(
      (item) => registryPathKey(item.path) === registryPathKey(row.path),
    );
    const found = matches[0];
    if (
      matches.length !== 1 ||
      !found ||
      found.bare ||
      found.detached ||
      found.locked ||
      found.prunable ||
      found.branch !== row.branch ||
      !found.head ||
      !/^[a-f0-9]{40,64}$/.test(found.head) ||
      verified(["rev-parse", "--verify", "HEAD"], row.path).trim() !==
        found.head
    )
      return refused(
        "The worktree is missing, locked, or its Git identity changed.",
      );
    const filters = git(
      ["config", "--get-regexp", "^filter\\..*\\.(clean|process)$"],
      row.path,
    );
    if (filters.status === 0)
      return refused(
        "Configured Git filters prevent a read-only cleanup check.",
      );
    if (filters.status !== 1 || filters.stdout !== "")
      throw Error("Unverified Git filters");
    // Status can recurse into a submodule and use that repository's filters.
    // This narrow preflight retains such targets instead of executing nested config.
    const tracked = verified(["ls-files", "--stage", "-z"], row.path);
    if (tracked.split("\0").some((entry) => entry.startsWith("160000 ")))
      return refused(
        "Tracked submodules require separate manual inspection; this worktree is retained.",
      );
    const indexFlags = verified(["ls-files", "-v", "-z"], row.path);
    if (indexFlags.split("\0").some((entry) => /^(S|[a-z]) /.test(entry)))
      return refused(
        "Git index flags can conceal tracked changes; this worktree is retained.",
      );
    if (
      indexFlags !== "" &&
      (!indexFlags.endsWith("\0") ||
        indexFlags
          .split("\0")
          .some((entry) => entry !== "" && !/^[HMRCK?] /.test(entry)))
    )
      throw Error("Unsupported Git index flags");
    if (
      verified(
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignored=matching",
          "--ignore-submodules=none",
        ],
        row.path,
      ) !== ""
    )
      return refused(
        "The worktree has tracked, untracked, ignored, or submodule changes.",
      );
    const inspection = worktreeInspectionRefusal(row.path);
    if (inspection)
      return refused("The worktree filesystem could not be safely inspected.");
    const readAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const source = await Promise.race([
      Promise.resolve().then(() => deps.readSources(project, root)),
      new Promise<ProjectSources>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error("Live scope read expired")),
          5000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (
      !source.issues ||
      !source.queue ||
      source.problems.length ||
      source.issues.length > 4096 ||
      source.queue.length > 4096 ||
      workspaceKey(source.workspace) !== workspaceKey(root) ||
      !Number.isFinite(Date.parse(source.asOf)) ||
      Date.parse(source.asOf) < readAt ||
      Date.parse(source.asOf) > Date.now()
    )
      throw Error("Incomplete live scope");
    const issue = selectProjectBeads(project, root, source.issues).find(
        (item) => item.id === row.beadId,
      ),
      queued = source.queue.filter((item) => item.beadId === row.beadId);
    if (
      !issue ||
      issue.status === "in_progress" ||
      queued.length > 1 ||
      queued.some(
        (item) => !item.backed || !["done", "halted"].includes(item.state),
      ) ||
      (issue.status !== "closed" && queued.length === 0)
    )
      return refused(
        "The live project Beads and queue read does not confirm settled scoped work.",
      );
    const intents = createProjectShiftRegistry({ home: options.home, root })
      .listAll(project.id)
      .filter(
        (intent) =>
          row.id.startsWith(`${intent.shiftId}-`) &&
          /^\d+$/.test(row.id.slice(intent.shiftId.length + 1)) &&
          workspaceKey(intent.workspace) === workspaceKey(root),
      );
    const intent = intents[0];
    if (intents.length !== 1 || !intent)
      return refused("No immutable project Shift original owns this worktree.");
    const evidence = readProjectShiftEvidence(options.home, intent, false),
      observed = observeProjectShift(intent, evidence),
      actual = z
        .object({
          beads: z
            .array(
              z
                .object({
                  beadId: z.string().min(1).max(128),
                  worktree: z.string().min(1).max(1024).optional(),
                  branch: z.string().min(1).max(256).optional(),
                })
                .passthrough(),
            )
            .max(10000),
        })
        .passthrough()
        .safeParse(evidence.record);
    if (!actual.success) throw Error("Incomplete Shift worktree evidence");
    const owners = actual.data.beads.filter(
      (item) =>
        item.worktree !== undefined &&
        registryPathKey(item.worktree) === registryPathKey(row.path),
    );
    if (
      observed.phase !== "stopped" ||
      observed.actual?.running !== 0 ||
      owners.length !== 1 ||
      owners[0]?.beadId !== row.beadId ||
      owners[0]?.branch !== row.branch
    )
      return refused(
        "The actual Shift does not confirm settled ownership of this bead, worktree and branch.",
      );
    const reservations = readReservationInventory({
      home: options.home,
      path: join(options.home, "ledger.db"),
      workspace: root,
    });
    if (reservations.state !== "complete")
      throw Error("Incomplete reservations");
    if (
      reservations.reservations.some(
        (claim) =>
          claim.beadId === row.beadId ||
          registryPathKey(
            isAbsolute(claim.worktree)
              ? claim.worktree
              : join(root, claim.worktree),
          ) === registryPathKey(row.path),
      )
    )
      return refused("An outstanding reservation still owns this worktree.");
    const activityStarted = performance.now();
    let inspected = 0;
    const budget = () => {
      if (++inspected > 4096 || performance.now() - activityStarted > 2000)
        throw Error("Incomplete ownership inventory");
    };
    const known = new Map(
      [
        ...catalog.projects,
        ...(catalog.deletedProjects ?? []).map((entry) => entry.project),
      ].map((item) => [item.id, item]),
    );
    const selected = new Set(
      [...known.values()]
        .filter((candidate) =>
          candidate.workspaces.some(
            (scope) =>
              workspaceKey(scope.root) === workspaceKey(root) ||
              scope.repositories.some(
                (path) => registryPathKey(path) === registryPathKey(root),
              ),
          ),
        )
        .map((candidate) => candidate.id),
    );
    for (const session of createSessionRegistry(options.home).listWorkspace(
      root,
    )) {
      budget();
      if (registryPathKey(session.worktree) === registryPathKey(row.path))
        return refused(
          "A retained session owner has been associated with this worktree; use its session controls.",
        );
      selected.add(session.projectId);
    }
    for (const identity of readAllRestartIdentityInventory(options.home)) {
      budget();
      if (
        workspaceKey(identity.workspace) === workspaceKey(root) &&
        ["reserved", "attempted", "admitted"].includes(identity.state)
      )
        selected.add(identity.address.projectId);
    }
    const conversationDirectory = join(options.home, "conversations");
    if (readHomeFile(conversationDirectory).problem !== null)
      throw Error("Unprotected private owners");
    let directoryInfo: Stats | undefined;
    try {
      directoryInfo = lstatSync(conversationDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (directoryInfo) {
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
        throw Error("Unsafe owner namespace");
      const directory = opendirSync(conversationDirectory);
      try {
        for (
          let entry = directory.readSync();
          entry !== null;
          entry = directory.readSync()
        ) {
          budget();
          if (
            entry.isSymbolicLink() ||
            (!entry.isFile() && !entry.isDirectory())
          )
            throw Error("Unknown private owner");
          const match =
            /^keeper-(project-[a-f0-9-]{36})(?:-proposals)?\.json$/.exec(
              entry.name,
            );
          if (match?.[1]) selected.add(match[1]);
        }
      } finally {
        directory.closeSync();
      }
      const after = lstatSync(conversationDirectory);
      if (
        after.dev !== directoryInfo.dev ||
        after.ino !== directoryInfo.ino ||
        after.isSymbolicLink()
      )
        throw Error("Changed owner namespace");
    }
    for (const id of selected) {
      budget();
      const candidate = known.get(id);
      if (!candidate) throw Error("Orphan or unlocatable owner");
      const activity = readProjectActivityInventory(
        options.home,
        root,
        candidate,
        budget,
      );
      if (activity.state === "unknown")
        throw Error("Incomplete private activity");
      if (activity.state !== "eligible")
        return refused(
          "Project activity in this repository is active or unresolved.",
        );
    }
    budget();
    const freshRegistry = readStrictWorktreeRegistry(root);
    const freshFilters = git(
      ["config", "--get-regexp", "^filter\\..*\\.(clean|process)$"],
      row.path,
    );
    if (freshFilters.status !== 1 || freshFilters.stdout !== "")
      throw Error("Changed Git filters");
    if (
      !freshRegistry.ok ||
      JSON.stringify(freshRegistry.value) !== JSON.stringify(registry.value) ||
      JSON.stringify(createProjectStore(options.home).read()) !==
        JSON.stringify(catalog) ||
      JSON.stringify(identities) !== JSON.stringify(pins()) ||
      verified(["worktree", "list", "--porcelain", "-z"]) !== listed ||
      verified(["rev-parse", "--verify", "HEAD"], row.path).trim() !==
        found.head ||
      verified(["ls-files", "--stage", "-z"], row.path) !== tracked ||
      verified(["ls-files", "-v", "-z"], row.path) !== indexFlags ||
      verified(
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignored=matching",
          "--ignore-submodules=none",
        ],
        row.path,
      ) !== "" ||
      worktreeInspectionRefusal(row.path) !== null
    )
      throw Error("Changed cleanup evidence");
    return {
      state: "eligible" as const,
      reasons: [],
      removalAuthorized: false as const,
      asOf: new Date().toISOString(),
      catalogRevision: catalog.revision,
      record: row,
      head: found.head,
    };
  } catch {
    return {
      state: "unknown",
      reasons: ["Cleanup eligibility could not be completely verified."],
    };
  }
}
