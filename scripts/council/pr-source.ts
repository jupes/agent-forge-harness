import { spawn } from "node:child_process";
import {
  isSensitivePath,
  type SecretPolicy,
  sanitizeContent,
  truncateUtf8,
} from "./context";
import type { ContextSourceMetadata } from "./types";

const DEFAULT_DIFF_BYTES = 150_000;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_LINKED_ISSUES = 10;

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (
  command: string[],
  cwd: string,
) => Promise<CommandResult>;

export type CompiledPullRequest = {
  displayName: string;
  locator: string;
  text: string;
  metadata: ContextSourceMetadata;
};

type PullRequestFile = {
  path: string;
  additions: number;
  deletions: number;
};

type PullRequestView = {
  number: number;
  url: string;
  title: string;
  body: string;
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: PullRequestFile[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const result = value[field];
  if (typeof result !== "string") {
    throw new Error(`gh PR metadata is missing ${field}`);
  }
  return result;
}

function requiredNumber(value: Record<string, unknown>, field: string): number {
  const result = value[field];
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error(`gh PR metadata is missing ${field}`);
  }
  return result;
}

function parsePullRequestView(text: string): PullRequestView {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("gh returned invalid PR metadata JSON");
  }
  if (!isRecord(value)) throw new Error("gh PR metadata must be an object");
  if (!Array.isArray(value.files)) {
    throw new Error("gh PR metadata is missing files");
  }
  const files = value.files.map((file, index) => {
    if (!isRecord(file)) throw new Error(`gh PR file ${index} is invalid`);
    return {
      path: requiredString(file, "path"),
      additions: requiredNumber(file, "additions"),
      deletions: requiredNumber(file, "deletions"),
    };
  });
  return {
    number: requiredNumber(value, "number"),
    url: requiredString(value, "url"),
    title: requiredString(value, "title"),
    body: requiredString(value, "body"),
    baseRefName: requiredString(value, "baseRefName"),
    baseRefOid: requiredString(value, "baseRefOid"),
    headRefName: requiredString(value, "headRefName"),
    headRefOid: requiredString(value, "headRefOid"),
    additions: requiredNumber(value, "additions"),
    deletions: requiredNumber(value, "deletions"),
    changedFiles: requiredNumber(value, "changedFiles"),
    files,
  };
}

function validatePullRequestReference(reference: string): string {
  const trimmed = reference.trim();
  if (/^[1-9][0-9]*$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (
      url.protocol === "https:" &&
      /\/pull\/[1-9][0-9]*\/?$/.test(url.pathname)
    ) {
      return url.toString();
    }
  } catch {
    // Fall through to the stable validation error below.
  }
  throw new Error("PR reference must be a positive number or pull-request URL");
}

function safeCommandError(command: string[], result: CommandResult): Error {
  const detail = sanitizeContent(result.stderr.slice(0, 1_000), "redact")
    .text.replace(/\s+/g, " ")
    .trim();
  return new Error(
    `${command.slice(0, 3).join(" ")} failed (${result.exitCode})${detail ? `: ${detail}` : ""}`,
  );
}

export function scrubProviderEnvironment(
  environment: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const commandEnvironment = { ...environment };
  for (const providerKey of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "DASHSCOPE_API_KEY",
    "OPENROUTER_API_KEY",
  ]) {
    delete commandEnvironment[providerKey];
  }
  return commandEnvironment;
}

export const runLocalCommand: CommandRunner = async (command, cwd) => {
  const commandEnvironment = scrubProviderEnvironment(process.env);
  return new Promise<CommandResult>((resolve, reject) => {
    const processHandle = spawn(command[0]!, command.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      env: {
        ...commandEnvironment,
        GH_PAGER: "cat",
        GH_PROMPT_DISABLED: "true",
      },
    });
    const stdout: Buffer[] = [],
      stderr: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      processHandle.kill();
      reject(
        new Error(`${command[0]} timed out after ${COMMAND_TIMEOUT_MS}ms`),
      );
    }, COMMAND_TIMEOUT_MS);
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 20_000_000) {
        processHandle.kill();
        clearTimeout(timer);
        reject(new Error(`${command[0]} output exceeded 20 MB`));
        return;
      }
      chunks.push(chunk);
    };
    processHandle.stdout.on("data", collect(stdout));
    processHandle.stderr.on("data", collect(stderr));
    processHandle.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    processHandle.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
};

function linkedIssueIds(body: string): { ids: string[]; omitted: number } {
  const all = [
    ...new Set(
      body.match(/\bagent-forge-harness-[a-z0-9]+(?:\.[0-9]+)*\b/gi) ?? [],
    ),
  ].sort();
  return {
    ids: all.slice(0, MAX_LINKED_ISSUES),
    omitted: Math.max(0, all.length - MAX_LINKED_ISSUES),
  };
}

async function loadAcceptanceCriteria(
  ids: string[],
  cwd: string,
  runner: CommandRunner,
): Promise<{ lines: string[]; omissions: string[] }> {
  const results = await Promise.all(
    ids.map(async (id) => {
      const command = ["bd", "show", id, "--json"];
      try {
        const result = await runner(command, cwd);
        if (result.exitCode !== 0)
          return { omission: `Acceptance criteria unavailable for ${id}.` };
        const parsed = JSON.parse(result.stdout) as unknown;
        const issue = Array.isArray(parsed) ? parsed[0] : parsed;
        if (!isRecord(issue) || typeof issue.acceptance_criteria !== "string")
          return { omission: `Acceptance criteria missing for ${id}.` };
        return { line: `${id}: ${issue.acceptance_criteria}` };
      } catch {
        return { omission: `Acceptance criteria unavailable for ${id}.` };
      }
    }),
  );
  return {
    lines: results.flatMap((result) => (result.line ? [result.line] : [])),
    omissions: results.flatMap((result) =>
      result.omission ? [result.omission] : [],
    ),
  };
}

function decodeGitPath(path: string): string {
  if (!path.startsWith('"')) return path;
  const parts: Buffer[] = [];
  const body = path.slice(1, -1);
  let offset = 0;
  for (const match of body.matchAll(/\\([0-7]{1,3}|[\\"abfnrtv])/g)) {
    parts.push(Buffer.from(body.slice(offset, match.index), "utf8"));
    const escapedCharacter = match[1]!;
    const character = (
      {
        a: "\x07",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
        v: "\v",
        '"': '"',
        "\\": "\\",
      } as Record<string, string>
    )[escapedCharacter];
    parts.push(
      character !== undefined
        ? Buffer.from(character)
        : Buffer.from([Number.parseInt(escapedCharacter, 8)]),
    );
    offset = match.index! + match[0].length;
  }
  parts.push(Buffer.from(body.slice(offset), "utf8"));
  return Buffer.concat(parts).toString("utf8");
}

function filterPatch(
  text: string,
  knownFiles: Set<string>,
): { text: string; includedFiles: string[]; omissions: string[] } {
  const included: string[] = [],
    omissions: string[] = [],
    sections: string[] = [];
  for (const section of text
    .split(/(?=^diff --git )/m)
    .filter((part) => part.trim())) {
    const header = section.split("\n", 1)[0]!;
    const match =
      /^diff --git ("(?:[^"\\]|\\.)*"|a\/.*?) ("(?:[^"\\]|\\.)*"|b\/.*)$/.exec(
        header,
      );
    if (!match) {
      omissions.push("An unrecognized patch section was excluded.");
      continue;
    }
    const oldPath = decodeGitPath(match[1]!).replace(/^a\//, ""),
      newPath = decodeGitPath(match[2]!).replace(/^b\//, "");
    if (isSensitivePath(oldPath) || isSensitivePath(newPath)) {
      omissions.push(`Sensitive file excluded: ${newPath}.`);
      continue;
    }
    if (!knownFiles.has(newPath)) {
      omissions.push(`Unresolved patch file excluded: ${newPath}.`);
      continue;
    }
    included.push(newPath);
    sections.push(section);
  }
  return {
    text: sections.join(""),
    includedFiles: [...new Set(included)],
    omissions,
  };
}

export async function compilePullRequest(
  reference: string,
  options: {
    cwd?: string;
    maxDiffBytes?: number;
    runner?: CommandRunner;
    secretPolicy?: SecretPolicy;
  } = {},
): Promise<CompiledPullRequest> {
  const cwd = options.cwd ?? process.cwd();
  const runner = options.runner ?? runLocalCommand;
  const safeReference = validatePullRequestReference(reference);
  const metadataCommand = [
    "gh",
    "pr",
    "view",
    safeReference,
    "--json",
    "number,url,title,body,baseRefName,baseRefOid,headRefName,headRefOid,additions,deletions,changedFiles,files",
  ];
  const metadataResult = await runner(metadataCommand, cwd);
  if (metadataResult.exitCode !== 0) {
    throw safeCommandError(metadataCommand, metadataResult);
  }
  const pullRequest = parsePullRequestView(metadataResult.stdout);
  if (pullRequest.files.length < pullRequest.changedFiles) {
    throw new Error(
      `PR metadata listed only ${pullRequest.files.length} of ${pullRequest.changedFiles} changed files; refusing an incomplete review`,
    );
  }
  const diffCommand = ["gh", "pr", "diff", safeReference, "--color=never"];
  const diffResult = await runner(diffCommand, cwd);
  if (diffResult.exitCode !== 0)
    throw safeCommandError(diffCommand, diffResult);
  const afterResult = await runner(metadataCommand, cwd);
  if (afterResult.exitCode !== 0)
    throw safeCommandError(metadataCommand, afterResult);
  const after = parsePullRequestView(afterResult.stdout);
  if (
    after.headRefOid !== pullRequest.headRefOid ||
    after.baseRefOid !== pullRequest.baseRefOid
  ) {
    throw new Error(
      "PR changed while its snapshot was being captured; retry the review",
    );
  }

  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_DIFF_BYTES;
  if (!Number.isInteger(maxDiffBytes) || maxDiffBytes < 1) {
    throw new Error("maxDiffBytes must be a positive integer");
  }
  const filtered = filterPatch(
    diffResult.stdout,
    new Set(pullRequest.files.map((file) => file.path)),
  );
  // Scan complete retained patches before truncation, including split keys.
  const safeDiff = sanitizeContent(
    filtered.text,
    options.secretPolicy ?? "reject",
  );
  const diff = truncateUtf8(safeDiff.text, maxDiffBytes);
  const linkedIssues = linkedIssueIds(pullRequest.body);
  const issueIds = linkedIssues.ids;
  const criteria = await loadAcceptanceCriteria(issueIds, cwd, runner);
  const omissions = [...filtered.omissions, ...criteria.omissions];
  if (linkedIssues.omitted > 0)
    omissions.push(
      `${linkedIssues.omitted} additional linked issue(s) were omitted after the ${MAX_LINKED_ISSUES}-issue safety cap.`,
    );
  if (safeDiff.redactions.length)
    omissions.push("Detected credentials were redacted from the patch.");
  if (diff.truncated) {
    omissions.push(`Diff truncated at ${maxDiffBytes} UTF-8 bytes.`);
  }
  const fileLines = pullRequest.files.map(
    (file) => `- ${file.path} (+${file.additions}/-${file.deletions})`,
  );
  const text = [
    `Pull request #${pullRequest.number}: ${pullRequest.title}`,
    `URL: ${pullRequest.url}`,
    `Base: ${pullRequest.baseRefName} ${pullRequest.baseRefOid}`,
    `Head: ${pullRequest.headRefName} ${pullRequest.headRefOid}`,
    `Change size: +${pullRequest.additions}/-${pullRequest.deletions} across ${pullRequest.changedFiles} files`,
    "",
    "Description:",
    pullRequest.body || "(no description)",
    "",
    "Changed files:",
    ...fileLines,
    "",
    "Linked acceptance criteria:",
    ...(criteria.lines.length > 0 ? criteria.lines : ["(none resolved)"]),
    "",
    "Known omissions:",
    ...(omissions.length > 0 ? omissions : ["(none)"]),
    "",
    "Patch:",
    diff.text,
  ].join("\n");
  const metadata: ContextSourceMetadata = {
    prNumber: pullRequest.number,
    url: pullRequest.url,
    baseRef: pullRequest.baseRefName,
    baseSha: pullRequest.baseRefOid,
    headRef: pullRequest.headRefName,
    headSha: pullRequest.headRefOid,
    changedFiles: pullRequest.changedFiles,
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    includedFiles: filtered.includedFiles,
    linkedIssueIds: issueIds,
    diffTruncated: diff.truncated,
    omissions,
  };
  return {
    displayName: `PR #${pullRequest.number}: ${pullRequest.title}`,
    locator: pullRequest.url,
    text,
    metadata,
  };
}
