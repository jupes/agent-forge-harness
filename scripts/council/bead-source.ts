/**
 * A Beads issue as a council source: its parts, in the order they must survive
 * the evidence budget.
 *
 * Bead content is private and a council run sends its evidence to model
 * providers, so this file reads exactly one bead — the one its caller names —
 * and only through `bd --readonly`. It never writes to the tracker.
 */

import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ForgeState } from "../forge/phases";
import { FORGE_RUNS_DIR, runSlugFromFilename } from "../forge/runs";
import { readRunState } from "../forge/runs-store";
import { type BeadsIssueId, parseBeadsIssueId } from "../run-correlation";
import {
  type ContextPart,
  type ContextPartsInput,
  ContextSecurityError,
  locateWorkspaceFile,
  readUtf8Text,
  type SecretPolicy,
  sanitizeContent,
} from "./context";
import {
  type CommandRunner,
  compilePullRequest,
  runLocalCommand,
  safeCommandError,
} from "./pr-source";
import type { ContextRedaction } from "./types";

export type CompiledBead = Pick<
  ContextPartsInput,
  "displayName" | "locator" | "metadata" | "parts" | "incomplete" | "redactions"
>;

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function oneLine(value: unknown): string {
  return text(value).replace(/\s+/g, " ");
}

/** What a read-only `bd` command printed, parsed; null when it is not JSON. */
async function readJson(
  command: string[],
  cwd: string,
  runner: CommandRunner,
): Promise<unknown> {
  const result = await runner(command, cwd);
  if (result.exitCode !== 0) throw safeCommandError(command, result);
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return null;
  }
}

/** The ids a bead depends on, each with its dependency type; the parent among them. */
function dependencyLine(issue: Fields): string {
  const seen = new Map<string, string>();
  const dependencies = Array.isArray(issue.dependencies)
    ? issue.dependencies
    : [];
  for (const dependency of dependencies) {
    if (!isRecord(dependency)) continue;
    const id = parseBeadsIssueId(dependency.id);
    if (id === null) continue;
    const type = text(dependency.dependency_type);
    seen.set(id, /^[a-z][a-z-]{0,39}$/.test(type) ? type : "");
  }
  const parent = parseBeadsIssueId(issue.parent);
  if (parent !== null && !seen.has(parent)) seen.set(parent, "parent-child");
  if (seen.size === 0) return "Depends on: (none)";
  return `Depends on: ${[...seen]
    .map(([id, type]) => (type ? `${id} (${type})` : id))
    .join(", ")}`;
}

function acceptancePart(id: BeadsIssueId, issue: Fields): ContextPart {
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map(oneLine).filter((label) => label.length > 0)
    : [];
  const lines = [
    `Bead: ${id}`,
    `Title: ${oneLine(issue.title) || "(untitled)"}`,
    `Type: ${oneLine(issue.issue_type) || "(unknown)"}`,
    ...(typeof issue.priority === "number" &&
    Number.isInteger(issue.priority) &&
    issue.priority >= 0
      ? [`Priority: P${issue.priority}`]
      : []),
    `Status: ${oneLine(issue.status) || "(unknown)"}`,
    `Labels: ${labels.length > 0 ? labels.join(", ") : "(none)"}`,
    dependencyLine(issue),
    "",
    "Acceptance criteria:",
    text(issue.acceptance_criteria) || "(none recorded)",
  ];
  return {
    label: "acceptance criteria",
    title: `bead ${id}: acceptance criteria`,
    chunks: [{ text: lines.join("\n") }],
  };
}

type BeadComment = { at: string; text: string };

/** The bead's own comments, newest first. */
function commentsOf(id: BeadsIssueId, rows: unknown[]): BeadComment[] {
  const comments: BeadComment[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (row.issue_id !== undefined && row.issue_id !== id) continue;
    const body = text(row.text);
    if (body.length === 0) continue;
    comments.push({ at: text(row.created_at), text: body });
  }
  // Array order breaks ties: `bd` lists comments oldest first.
  return comments
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.at.localeCompare(a.entry.at) || b.index - a.index)
    .map(({ entry }) => entry);
}

function commentsPart(id: BeadsIssueId, comments: BeadComment[]): ContextPart {
  return {
    label: "latest comments",
    title: `bead ${id}: latest comments, newest first`,
    unit: "comment",
    chunks: comments.map((entry) => ({
      text: `[${entry.at}]\n${entry.text}`,
      name: `the comment of ${entry.at}`,
    })),
  };
}

/** A tenth of the budget until every later part has had its turn. */
const DESCRIPTION_SHARE = 0.1;

function descriptionPart(id: BeadsIssueId, issue: Fields): ContextPart {
  const sections: Array<[string, string]> = [
    ["Description", text(issue.description)],
    ["Design", text(issue.design)],
    ["Notes", text(issue.notes)],
  ];
  return {
    label: "description",
    title: `bead ${id}: description`,
    maxShare: DESCRIPTION_SHARE,
    chunks: sections
      .filter(([, body]) => body.length > 0)
      .map(([heading, body]) => ({ text: `${heading}:\n${body}` })),
  };
}

/** Everything the bead says, oldest mention first: its fields, then its comments. */
function mentionTexts(issue: Fields, newestFirst: BeadComment[]): string[] {
  return [
    ...[
      issue.external_ref,
      issue.spec_id,
      issue.description,
      issue.acceptance_criteria,
      issue.design,
      issue.notes,
    ].map(text),
    ...newestFirst.map((entry) => entry.text).reverse(),
  ];
}

const MAX_LINKED_FILES = 6;
/** How much of the budget one linked file takes before the pull request has had its turn. */
const LINKED_FILE_SHARE = 0.15;

const PATH_SEGMENT = "[A-Za-z0-9_-][A-Za-z0-9_.-]*";
const LINKED_PATH = new RegExp(
  `^(?:(?:plans/(?:research|drafts|committed)|docs/plans)(?:/${PATH_SEGMENT})+|reports/${PATH_SEGMENT})$`,
);

/**
 * Whether a workspace-relative path is where a plan, a research note or a
 * report lives. Only a file directly inside `reports/` counts: its
 * subdirectories hold council runs, whose reports embed earlier evidence.
 */
export function isLinkedArtifactPath(path: string): boolean {
  return (
    path.length <= 200 &&
    path.endsWith(".md") &&
    !path.includes("..") &&
    LINKED_PATH.test(path)
  );
}

/** A path as the bead or a run state wrote it, safe to show in a label. */
function shownPath(path: string): string {
  return oneLine(path).slice(0, 120);
}

function note(label: string, words: string): ContextPart {
  return { label, chunks: [], note: words };
}

const UNREADABLE = {
  missing: "missing, not packed",
  outside: "not packed, it resolves outside the workspace",
  "not-a-file": "not packed, not a regular file",
  sensitive: "not packed, a credential file name",
} as const;

/** One linked file as a part: its text, or a note saying why it is not packed. */
function linkedFilePart(cwd: string, label: string, path: string): ContextPart {
  if (!isLinkedArtifactPath(path))
    return note(label, "refused, not a plan, research or report path");
  const found = locateWorkspaceFile(resolve(cwd, path), cwd);
  if (!found.ok) return note(label, UNREADABLE[found.reason]);
  // A link inside the workspace can lead anywhere in it: the place the file
  // really is has to be a plan, research or report path too.
  if (!isLinkedArtifactPath(found.locator))
    return note(
      label,
      "refused, it resolves to a path that is not a plan, research or report",
    );
  const body = readUtf8Text(found.path);
  if (body === null) return note(label, "not packed, not UTF-8 text");
  if (body.trim().length === 0) return note(label, "empty, not packed");
  return {
    label,
    maxShare: LINKED_FILE_SHARE,
    chunks: [{ text: body }],
  };
}

/**
 * The forge run that works this bead, newest first: a run that names the bead,
 * or one that names no bead and whose epic is the bead. A run that works
 * another bead is never this bead's, whatever its epic.
 */
function beadRun(id: BeadsIssueId, cwd: string): ForgeState | null {
  let names: string[];
  try {
    names = readdirSync(join(cwd, FORGE_RUNS_DIR));
  } catch {
    return null;
  }
  let newest: ForgeState | null = null;
  for (const name of names) {
    const slug = runSlugFromFilename(name);
    if (slug === null) continue;
    // A read, never `listRuns`: that one migrates files on the way past.
    const state = readRunState(slug, cwd);
    if (state === null) continue;
    const owns =
      state.beadId !== undefined ? state.beadId === id : state.epic === id;
    if (!owns) continue;
    if (
      newest === null ||
      String(state.updatedAt).localeCompare(String(newest.updatedAt)) > 0
    )
      newest = state;
  }
  return newest;
}

const PATH_MENTION =
  /(?<![A-Za-z0-9_./-])(?:plans|docs|reports)\/[A-Za-z0-9_./-]+?\.md(?![A-Za-z0-9_-])/g;

/** The run's plan, research and report, then the paths the bead names. */
function linkedFileParts(
  cwd: string,
  run: ForgeState | null,
  texts: string[],
): ContextPart[] {
  const linked: Array<{ label: string; path: string }> = [];
  const seen = new Set<string>();
  const artifacts: unknown = run?.artifacts;
  if (isRecord(artifacts))
    for (const [kind, key] of [
      ["plan", "plan"],
      ["research", "research"],
      ["report", "ship"],
    ] as const) {
      const path = text(artifacts[key]);
      if (path.length === 0 || seen.has(path)) continue;
      seen.add(path);
      linked.push({ label: `linked ${kind} ${shownPath(path)}`, path });
    }
  for (const body of texts)
    for (const match of body.matchAll(PATH_MENTION)) {
      const path = match[0];
      if (seen.has(path) || !isLinkedArtifactPath(path)) continue;
      seen.add(path);
      linked.push({ label: `linked file ${path}`, path });
    }
  const parts = linked
    .slice(0, MAX_LINKED_FILES)
    .map(({ label, path }) => linkedFilePart(cwd, label, path));
  const more = linked.length - MAX_LINKED_FILES;
  if (more > 0)
    parts.push(
      note(
        `${more} more linked file${more === 1 ? "" : "s"}`,
        `not packed (limit ${MAX_LINKED_FILES})`,
      ),
    );
  return parts;
}

/** The workspace's own repository, as its origin remote names it. */
type Origin = { host: string; owner: string; repo: string };

/**
 * An origin remote as host, owner and repository, or null when it is not one
 * this file can match a pull request against. Credentials in the remote are
 * dropped here and the remote's text goes nowhere else.
 */
export function parseOrigin(remote: string): Origin | null {
  const value = remote.trim();
  if (value.length === 0 || value.length > 500 || /\s/.test(value)) return null;
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    // An https remote on another port serves pull request pages there too,
    // and those never match; an ssh port says nothing about the web host.
    if (url.protocol === "https:" ? url.port !== "" : url.protocol !== "ssh:")
      return null;
    host = url.hostname;
    path = url.pathname;
  } else {
    const scp = /^(?:[^@/:]+@)?([^@/:]+):(.+)$/.exec(value);
    if (!scp?.[1]?.includes(".")) return null;
    host = scp[1];
    path = `/${scp[2]}`;
  }
  const match =
    /^\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
      path,
    );
  const owner = match?.[1];
  const repo = match?.[2];
  if (!owner || !repo || repo === "." || repo === "..") return null;
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return null;
  return { host: host.toLowerCase(), owner, repo };
}

/**
 * The number of the origin repository's pull request `url` points at, or null.
 * The test is on the parsed URL, so nothing a mention spells differently —
 * userinfo, a port, dot segments, a look-alike host — passes as the origin.
 */
function ownPullRequest(url: URL, origin: Origin): number | null {
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
    return null;
  if (url.port !== "" || url.hostname.toLowerCase() !== origin.host)
    return null;
  const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]{0,9})(?:\/.*)?$/.exec(
    url.pathname,
  );
  if (!match) return null;
  if (
    match[1]?.toLowerCase() !== origin.owner.toLowerCase() ||
    match[2]?.toLowerCase() !== origin.repo.toLowerCase()
  )
    return null;
  return Number(match[3]);
}

const URL_MENTION = /https?:\/\/[^\s<>"'`]+/gi;
const PULL_REQUEST_PATH = /\/pull\/[0-9]+(?:\/|$)/;
const MAX_REFERENCES = 10;

/** A URL as it was meant: without the punctuation and brackets of the sentence around it. */
function trimMention(token: string): string {
  let value = token;
  for (;;) {
    const last = value.at(-1) ?? "";
    const opener = { ")": "(", "]": "[", "}": "{" }[last];
    if (".,;:!?*_~".includes(last) && last !== "") value = value.slice(0, -1);
    else if (
      opener !== undefined &&
      value.split(last).length > value.split(opener).length
    )
      value = value.slice(0, -1);
    else return value;
  }
}

/** Every pull-request-shaped URL the texts mention, oldest mention first. */
function pullRequestMentions(texts: string[]): URL[] {
  const mentions: URL[] = [];
  for (const body of texts)
    for (const match of body.matchAll(URL_MENTION)) {
      let url: URL;
      try {
        url = new URL(trimMention(match[0]));
      } catch {
        continue;
      }
      if (PULL_REQUEST_PATH.test(url.pathname)) mentions.push(url);
    }
  return mentions;
}

async function readOrigin(
  cwd: string,
  runner: CommandRunner,
): Promise<Origin | null> {
  try {
    const result = await runner(["git", "remote", "get-url", "origin"], cwd);
    return result.exitCode === 0 ? parseOrigin(result.stdout) : null;
  } catch {
    return null;
  }
}

type PullRequestParts = {
  parts: ContextPart[];
  /** The URL that was captured. */
  url?: string;
  incomplete: boolean;
  redactions: ContextRedaction[];
};

/**
 * The pull request part and the notes about every other pull request URL.
 *
 * Only a URL of the workspace's own origin repository is ever fetched, and
 * what `gh` is handed is rebuilt from the origin and the number: never the
 * mention as written, never a bare number.
 */
async function pullRequestParts(
  texts: string[],
  options: {
    cwd: string;
    runner: CommandRunner;
    secretPolicy: SecretPolicy;
    maxBytes: number | undefined;
  },
): Promise<PullRequestParts> {
  const result: PullRequestParts = {
    parts: [],
    incomplete: false,
    redactions: [],
  };
  const mentions = pullRequestMentions(texts);
  if (mentions.length === 0) return result;
  const origin = await readOrigin(options.cwd, options.runner);

  let packed: number | null = null;
  const named: number[] = [];
  const references: string[] = [];
  for (const url of mentions) {
    const number = origin ? ownPullRequest(url, origin) : null;
    if (number !== null) {
      if (packed !== null && packed !== number) named.push(packed);
      packed = number;
      continue;
    }
    // Rebuilt from the parsed URL: no userinfo, no query, no fragment.
    references.push(`${url.protocol}//${url.host}${url.pathname}`);
  }

  if (packed !== null && origin) {
    const number = packed;
    const label = `pull request #${number}`;
    const url = `https://${origin.host}/${origin.owner}/${origin.repo}/pull/${number}`;
    try {
      const compiled = await compilePullRequest(url, {
        cwd: options.cwd,
        runner: options.runner,
        secretPolicy: options.secretPolicy,
        maxDiffBytes: options.maxBytes,
        linkedCriteria: false,
      });
      result.parts.push({
        label,
        title: compiled.displayName,
        chunks: [{ text: compiled.text }],
      });
      result.url = url;
      result.redactions = compiled.redactions;
      if (compiled.metadata.diffTruncated === true) result.incomplete = true;
    } catch (error) {
      if (error instanceof ContextSecurityError)
        throw new ContextSecurityError(
          error.message.replace(
            "potential secrets detected;",
            `potential secrets detected in ${label};`,
          ),
        );
      const reason = sanitizeContent(
        error instanceof Error ? error.message : String(error),
        "redact",
      )
        .text.replace(/\s+/g, " ")
        .slice(0, 160);
      result.parts.push(note(label, `not packed, capture failed (${reason})`));
      result.incomplete = true;
    }
  }

  const notes: ContextPart[] = [
    ...[...new Set(named)]
      .filter((number) => number !== packed)
      .map((number) =>
        note(
          `pull request #${number}`,
          "named, not packed (a later mention was packed)",
        ),
      ),
    ...[...new Set(references)].map((reference) =>
      note(
        `reference ${reference.slice(0, 200)}`,
        origin
          ? "not fetched, not this workspace's origin repository"
          : "not fetched, the origin repository could not be read",
      ),
    ),
  ];
  result.parts.push(...notes.slice(0, MAX_REFERENCES));
  const more = notes.length - MAX_REFERENCES;
  if (more > 0)
    result.parts.push(
      note(
        `${more} more pull request reference${more === 1 ? "" : "s"}`,
        `not listed (limit ${MAX_REFERENCES})`,
      ),
    );
  return result;
}

export async function compileBead(
  reference: string,
  options: {
    cwd?: string | undefined;
    runner?: CommandRunner | undefined;
    secretPolicy?: SecretPolicy | undefined;
    maxBytes?: number | undefined;
  } = {},
): Promise<CompiledBead> {
  const id = parseBeadsIssueId(reference);
  if (id === null) throw new Error("bead source needs a Beads issue id");
  const cwd = options.cwd ?? process.cwd();
  const runner = options.runner ?? runLocalCommand;

  const shown = await readJson(
    ["bd", "--readonly", "show", id, "--json"],
    cwd,
    runner,
  );
  const issue = Array.isArray(shown) ? shown[0] : shown;
  if (!isRecord(issue) || typeof issue.id !== "string")
    throw new Error(`bd printed no readable issue for ${id}`);
  // `bd show` resolves a partial id. Only the bead the operator named in full
  // is packed, so the answer has to be that bead.
  if (issue.id !== id)
    throw new Error(
      `bd returned a different issue for ${id}; name the bead by its full id`,
    );
  const rows = await readJson(
    ["bd", "--readonly", "comments", id, "--json"],
    cwd,
    runner,
  );
  if (!Array.isArray(rows))
    throw new Error(`bd printed no readable comments for ${id}`);
  const comments = commentsOf(id, rows);
  const texts = mentionTexts(issue, comments);
  const run = beadRun(id, cwd);
  const pullRequest = await pullRequestParts(texts, {
    cwd,
    runner,
    secretPolicy: options.secretPolicy ?? "reject",
    maxBytes: options.maxBytes,
  });

  return {
    displayName: `${id}: ${oneLine(issue.title) || "(untitled)"}`,
    locator: id,
    metadata: {
      beadId: id,
      ...(run ? { forgeRun: run.slug } : {}),
      ...(pullRequest.url ? { pullRequest: pullRequest.url } : {}),
    },
    parts: [
      acceptancePart(id, issue),
      commentsPart(id, comments),
      descriptionPart(id, issue),
      ...linkedFileParts(cwd, run, texts),
      ...pullRequest.parts,
    ],
    incomplete: pullRequest.incomplete,
    redactions: pullRequest.redactions,
  };
}
