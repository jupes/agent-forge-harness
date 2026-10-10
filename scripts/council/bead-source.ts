/**
 * A Beads issue as a council source: its parts, in the order they must survive
 * the evidence budget.
 *
 * Bead content is private and a council run sends its evidence to model
 * providers, so this file reads exactly one bead — the one its caller names —
 * and only through `bd --readonly`. It never writes to the tracker.
 *
 * Every field it reads is scanned for secrets, whole, before anything is
 * derived from it: before a label is cut, before a path or a URL is taken out
 * of it, before a pull request is fetched.
 */

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ForgeState } from "../forge/phases";
import { FORGE_RUNS_DIR, runSlugFromFilename } from "../forge/runs";
import { readRunState } from "../forge/runs-store";
import { type BeadsIssueId, parseBeadsIssueId } from "../run-correlation";
import {
  type ContextPart,
  type ContextPartsInput,
  ContextSecurityError,
  cutChars,
  DEFAULT_MAX_BYTES,
  locateWorkspaceFile,
  readUtf8Text,
  type SecretPolicy,
  sanitizeContent,
  scanNamed,
  withoutControls,
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

/** `value` on one line, with nothing in it that could steer a terminal. */
function oneLine(value: string): string {
  return withoutControls(value).replace(/\s+/g, " ").trim();
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

/** The bead's free text after the secret scan: what every part and mention is built from. */
type BeadText = {
  /** On one line, scanned in that form. */
  title: string;
  /** Each on one line, scanned in that form. */
  labels: string[];
  criteria: string;
  description: string;
  design: string;
  notes: string;
  /** Read for a pull request URL or a linked path only; never packed. */
  externalRef: string;
  specId: string;
};

type BeadComment = { at: string; text: string };

// The header rides with the acceptance criteria, so it is kept small enough
// that it cannot push them out of their own part.
const TITLE_MAX_CHARS = 300;
const LABEL_MAX_CHARS = 80;
const MAX_LABELS = 20;
const MAX_DEPENDENCIES = 50;

function listed(items: string[], max: number): string {
  if (items.length === 0) return "(none)";
  const more = items.length - max;
  return `${items.slice(0, max).join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

/** A short word the tracker chose (a type, a status), or "" when it is not one. */
function word(value: unknown): string {
  const candidate = text(value);
  return /^[A-Za-z][A-Za-z0-9_ -]{0,39}$/.test(candidate) ? candidate : "";
}

/** The ids a bead depends on, each with its dependency type; the parent among them. */
function dependencyLine(issue: Fields): string {
  const seen = new Map<string, string>();
  const dependencies = Array.isArray(issue.dependencies)
    ? issue.dependencies
    : [];
  for (const dependency of dependencies) {
    // Of a dependency, the id and the type: never its title or its text.
    if (!isRecord(dependency)) continue;
    const id = parseBeadsIssueId(dependency.id);
    if (id === null) continue;
    const type = text(dependency.dependency_type);
    seen.set(id, /^[a-z][a-z-]{0,39}$/.test(type) ? type : "");
  }
  const parent = parseBeadsIssueId(issue.parent);
  if (parent !== null && !seen.has(parent)) seen.set(parent, "parent-child");
  return `Depends on: ${listed(
    [...seen].map(([id, type]) => (type ? `${id} (${type})` : id)),
    MAX_DEPENDENCIES,
  )}`;
}

function shownTitle(safe: BeadText): string {
  return cutChars(safe.title, TITLE_MAX_CHARS) || "(untitled)";
}

function acceptancePart(
  id: BeadsIssueId,
  issue: Fields,
  safe: BeadText,
): ContextPart {
  const labels = safe.labels
    .map((label) => cutChars(label, LABEL_MAX_CHARS))
    .filter((label) => label.length > 0);
  const lines = [
    `Bead: ${id}`,
    `Title: ${shownTitle(safe)}`,
    `Type: ${word(issue.issue_type) || "(unknown)"}`,
    ...(typeof issue.priority === "number" &&
    Number.isInteger(issue.priority) &&
    issue.priority >= 0 &&
    issue.priority <= 9
      ? [`Priority: P${issue.priority}`]
      : []),
    `Status: ${word(issue.status) || "(unknown)"}`,
    `Labels: ${listed(labels, MAX_LABELS)}`,
    dependencyLine(issue),
    "",
    "Acceptance criteria:",
    safe.criteria || "(none recorded)",
  ];
  return {
    label: "acceptance criteria",
    title: `bead ${id}: acceptance criteria`,
    chunks: [{ text: lines.join("\n") }],
  };
}

const TIMESTAMP =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9:.]{5,15}(?:Z|[+-][0-9]{2}:?[0-9]{2})?$/;

/** The bead's own comments, newest first. */
function commentsOf(id: BeadsIssueId, rows: unknown[]): BeadComment[] {
  const comments: BeadComment[] = [];
  for (const row of rows) {
    // Only rows that say they belong to this bead.
    if (!isRecord(row) || row.issue_id !== id) continue;
    const body = text(row.text);
    if (body.length === 0) continue;
    const at = text(row.created_at);
    comments.push({ at: TIMESTAMP.test(at) ? at : "unknown time", text: body });
  }
  // By the instant, not the spelling: an offset or milliseconds must not
  // reorder them. A timestamp that does not parse counts as the oldest, and
  // array order breaks ties: `bd` lists comments oldest first.
  const instant = (at: string): number => {
    const time = Date.parse(at);
    return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
  };
  return comments
    .map((entry, index) => ({ entry, index, time: instant(entry.at) }))
    .sort((a, b) =>
      a.time === b.time ? b.index - a.index : b.time > a.time ? 1 : -1,
    )
    .map(({ entry }) => entry);
}

/** Everything besides a line feed that ends a line somewhere. */
const LINE_ENDINGS = ["\r", "\u000b", "\u000c", "\u0085", "\u2028", "\u2029"];

/**
 * A comment as it is packed: its time on a line of its own, its text quoted.
 * Only that first line is unquoted, so text inside a comment cannot pass
 * itself off as the header of another, newer comment.
 */
function commentChunk(entry: BeadComment): string {
  let body = entry.text.replaceAll("\r\n", "\n");
  for (const ending of LINE_ENDINGS) body = body.replaceAll(ending, "\n");
  const quoted = body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `[${entry.at}]\n${quoted}`;
}

function commentsPart(id: BeadsIssueId, comments: BeadComment[]): ContextPart {
  return {
    label: "latest comments",
    title: `bead ${id}: latest comments, newest first`,
    unit: "comment",
    chunks: comments.map((entry) => ({
      text: commentChunk(entry),
      name: `the comment of ${entry.at}`,
    })),
  };
}

/** A tenth of the budget until every later part has had its turn. */
const DESCRIPTION_SHARE = 0.1;

function descriptionPart(id: BeadsIssueId, safe: BeadText): ContextPart {
  const sections: Array<[string, string]> = [
    ["Description", safe.description],
    ["Design", safe.design],
    ["Notes", safe.notes],
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
function mentionTexts(safe: BeadText, newestFirst: BeadComment[]): string[] {
  return [
    safe.externalRef,
    safe.specId,
    safe.description,
    safe.criteria,
    safe.design,
    safe.notes,
    ...newestFirst.map((entry) => entry.text).reverse(),
  ];
}

const MAX_LINKED_FILES = 6;
/** How much of the budget one linked file takes before the pull request has had its turn. */
const LINKED_FILE_SHARE = 0.15;
/** A plan or a report larger than this is not read at all. */
const MAX_LINKED_FILE_BYTES = 2_000_000;

const PATH_SEGMENT = "[A-Za-z0-9_-][A-Za-z0-9_.-]*";
const LINKED_PATH = new RegExp(
  `^(?:(?:plans/(?:research|drafts|committed)|docs/plans)(?:/${PATH_SEGMENT})+|reports/${PATH_SEGMENT})$`,
);

/**
 * Whether a workspace-relative path is where a plan, a research note or a
 * report lives. Only a file directly inside `reports/` counts, and nothing
 * under a `council-runs` directory anywhere: council reports embed the
 * evidence of earlier runs.
 */
function isLinkedArtifactPath(path: string): boolean {
  return (
    path.length <= 200 &&
    path.endsWith(".md") &&
    !path.includes("..") &&
    !path.toLowerCase().split("/").includes("council-runs") &&
    LINKED_PATH.test(path)
  );
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

/** One file per real path, whatever spelling named it. */
function sameFileKey(realPath: string): string {
  return process.platform === "win32" || process.platform === "darwin"
    ? realPath.toLowerCase()
    : realPath;
}

type LinkedFiles = { parts: ContextPart[]; incomplete: boolean };

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

/**
 * The run's plan, research and report, then the paths the bead names: each as
 * its text, or as a note saying why it is not packed. Never an error.
 */
function linkedFileParts(
  cwd: string,
  run: ForgeState | null,
  texts: string[],
): LinkedFiles {
  const result: LinkedFiles = { parts: [], incomplete: false };
  const linked: Array<{ label: string; path: string }> = [];
  const named = new Set<string>();
  const artifacts: unknown = run?.artifacts;
  if (isRecord(artifacts))
    for (const [kind, key] of [
      ["plan", "plan"],
      ["research", "research"],
      ["report", "ship"],
    ] as const) {
      const path = text(artifacts[key]);
      if (path.length === 0 || named.has(path)) continue;
      named.add(path);
      // A run state is a file anyone can write: what it names is shown only
      // when it is a path this source would read.
      if (isLinkedArtifactPath(path))
        linked.push({ label: `linked ${kind} ${path}`, path });
      else
        result.parts.push(
          note(
            `linked ${kind}`,
            "refused, the run state names a path that is not a plan, research or report",
          ),
        );
    }
  for (const body of texts)
    for (const match of body.matchAll(PATH_MENTION)) {
      const path = match[0];
      if (named.has(path) || !isLinkedArtifactPath(path)) continue;
      named.add(path);
      linked.push({ label: `linked file ${path}`, path });
    }

  const packed = new Map<string, string>();
  for (const { label, path } of linked.slice(0, MAX_LINKED_FILES)) {
    const found = locateWorkspaceFile(resolve(cwd, path), cwd);
    if (!found.ok) {
      result.parts.push(note(label, UNREADABLE[found.reason]));
      continue;
    }
    // A link inside the workspace can lead anywhere in it: the place the file
    // really is has to be a plan, research or report path too.
    if (!isLinkedArtifactPath(found.locator)) {
      result.parts.push(
        note(
          label,
          "refused, it resolves to a path that is not a plan, research or report",
        ),
      );
      continue;
    }
    const first = packed.get(sameFileKey(found.path));
    if (first !== undefined) {
      result.parts.push(
        note(label, `the same file as ${first}, not packed twice`),
      );
      continue;
    }
    if (statSync(found.path).size > MAX_LINKED_FILE_BYTES) {
      // It exists and is not sent: the pack is not the whole picture.
      result.incomplete = true;
      result.parts.push(
        note(
          label,
          `too large, not packed (over ${MAX_LINKED_FILE_BYTES} bytes)`,
        ),
      );
      continue;
    }
    const body = readUtf8Text(found.path);
    if (body === null) {
      result.parts.push(note(label, "not packed, not UTF-8 text"));
      continue;
    }
    if (body.trim().length === 0) {
      result.parts.push(note(label, "empty, not packed"));
      continue;
    }
    packed.set(sameFileKey(found.path), path);
    result.parts.push({
      label,
      maxShare: LINKED_FILE_SHARE,
      chunks: [{ text: body }],
    });
  }
  const more = linked.length - MAX_LINKED_FILES;
  if (more > 0)
    result.parts.push(
      note(
        `${more} more linked file${more === 1 ? "" : "s"}`,
        `not packed (limit ${MAX_LINKED_FILES})`,
      ),
    );
  return result;
}

/** The workspace's own repository, as its origin remote names it. */
type Origin = { host: string; owner: string; repo: string };

/**
 * An origin remote as host, owner and repository, or null when it is not one
 * this file can match a pull request against. Credentials in the remote are
 * dropped here and the remote's text goes nowhere else.
 */
function parseOrigin(remote: string): Origin | null {
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

const OPENERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * A URL as it was meant: without the punctuation and the unbalanced closing
 * brackets of the sentence around it. One pass over the token, however long a
 * run of brackets follows it.
 */
function trimMention(token: string): string {
  const count = new Map<string, number>();
  for (const char of token)
    if ("()[]{}".includes(char)) count.set(char, (count.get(char) ?? 0) + 1);
  let end = token.length;
  while (end > 0) {
    const last = token.charAt(end - 1);
    const opener = OPENERS[last];
    if (".,;:!?*_~".includes(last)) {
      end -= 1;
    } else if (
      opener !== undefined &&
      (count.get(last) ?? 0) > (count.get(opener) ?? 0)
    ) {
      count.set(last, (count.get(last) ?? 0) - 1);
      end -= 1;
    } else break;
  }
  return token.slice(0, end);
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
    // Rebuilt from the parsed URL: no userinfo, no query, no fragment. Not
    // cut here: the pack scans the whole line before it shortens it.
    references.push(`${url.protocol}//${url.host}${url.pathname}`);
  }

  if (packed !== null && origin) {
    const number = packed;
    const label = `pull request #${number}`;
    const url = `https://${origin.host}/${origin.owner}/${origin.repo}/pull/${number}`;
    const failed = (reason: string): void => {
      result.parts.push(note(label, `not packed, capture failed (${reason})`));
      result.incomplete = true;
    };
    try {
      const compiled = await compilePullRequest(url, {
        cwd: options.cwd,
        runner: options.runner,
        secretPolicy: options.secretPolicy,
        // The whole budget: the pack decides how much of the patch fits,
        // after the parts that come before it.
        maxDiffBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
        linkedCriteria: false,
      });
      // `gh` was asked for one pull request; anything else it answers with is
      // not evidence for this bead.
      let answered: number | null = null;
      try {
        answered = ownPullRequest(
          new URL(String(compiled.metadata.url)),
          origin,
        );
      } catch {
        answered = null;
      }
      if (compiled.metadata.prNumber !== number || answered !== number) {
        failed("gh answered with another repository or number");
      } else {
        result.parts.push({
          label,
          title: compiled.displayName,
          chunks: [{ text: compiled.text }],
          sourceCut: compiled.metadata.diffTruncated === true,
        });
        result.url = url;
        result.redactions = compiled.redactions;
        const omissions = Array.isArray(compiled.metadata.omissions)
          ? compiled.metadata.omissions.length
          : 0;
        if (omissions > 0)
          result.parts.push(
            note(
              `${label} capture`,
              `${omissions} omission${omissions === 1 ? "" : "s"} recorded`,
            ),
          );
      }
    } catch (error) {
      if (error instanceof ContextSecurityError)
        throw new ContextSecurityError(
          error.message.replace(
            "potential secrets detected;",
            `potential secrets detected in ${label};`,
          ),
        );
      failed(
        sanitizeContent(
          error instanceof Error ? error.message : String(error),
          "redact",
        )
          .text.replace(/\s+/g, " ")
          .slice(0, 160),
      );
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
        `reference ${reference}`,
        origin
          ? "not fetched, not a pull request URL of this workspace's origin repository"
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
  const policy = options.secretPolicy ?? "reject";

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

  // Scanned here, whole, before anything is made of them. Under the reject
  // policy a hit ends the pack now, before a file is read or a pull request
  // fetched; under redact, everything below works on the redacted text.
  const found = new Map<string, number>();
  const clean = (value: unknown, where: string): string =>
    scanNamed(text(value), policy, where, found);
  // A title or a label is shown on one line and cut short. Making it one
  // line can put a secret together, so that form is scanned as well, whole.
  const cleanLine = (value: unknown, where: string): string =>
    scanNamed(oneLine(clean(value, where)), policy, where, found);
  const safe: BeadText = {
    title: cleanLine(issue.title, "the title"),
    labels: (Array.isArray(issue.labels) ? issue.labels : []).map((label) =>
      cleanLine(label, "the labels"),
    ),
    criteria: clean(issue.acceptance_criteria, "the acceptance criteria"),
    description: clean(issue.description, "the description"),
    design: clean(issue.design, "the design notes"),
    notes: clean(issue.notes, "the notes"),
    externalRef: clean(issue.external_ref, "the external reference"),
    specId: clean(issue.spec_id, "the spec id"),
  };
  const comments = commentsOf(id, rows).map((entry) => ({
    at: entry.at,
    text: clean(entry.text, `the comment of ${entry.at}`),
  }));
  const own = [
    acceptancePart(id, issue, safe),
    commentsPart(id, comments),
    descriptionPart(id, safe),
  ];
  const texts = mentionTexts(safe, comments);
  const run = beadRun(id, cwd);
  const linked = linkedFileParts(cwd, run, texts);
  const pullRequest = await pullRequestParts(texts, {
    cwd,
    runner,
    secretPolicy: policy,
    maxBytes: options.maxBytes,
  });
  for (const redaction of pullRequest.redactions)
    found.set(
      redaction.kind,
      (found.get(redaction.kind) ?? 0) + redaction.count,
    );

  return {
    displayName: `${id}: ${shownTitle(safe)}`,
    locator: id,
    metadata: {
      beadId: id,
      ...(run ? { forgeRun: run.slug } : {}),
      ...(pullRequest.url ? { pullRequest: pullRequest.url } : {}),
    },
    parts: [...own, ...linked.parts, ...pullRequest.parts],
    incomplete: linked.incomplete || pullRequest.incomplete,
    redactions: [...found].map(([kind, count]) => ({ kind, count })),
  };
}
