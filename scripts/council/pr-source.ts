import { sanitizeContent } from "./context";
import type { ContextSourceMetadata } from "./types";

const DEFAULT_DIFF_BYTES = 150_000;
const COMMAND_TIMEOUT_MS = 30_000;

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

function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return { text, truncated: false };
  let boundary = maxBytes;
  while (boundary > 0 && (bytes[boundary]! & 0xc0) === 0x80) boundary -= 1;
  return {
    text: new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(0, boundary),
    ),
    truncated: true,
  };
}

function safeCommandError(command: string[], result: CommandResult): Error {
  const detail = sanitizeContent(result.stderr.slice(0, 1_000), "redact")
    .text.replace(/\s+/g, " ")
    .trim();
  return new Error(
    `${command.slice(0, 3).join(" ")} failed (${result.exitCode})${detail ? `: ${detail}` : ""}`,
  );
}

export const runLocalCommand: CommandRunner = async (command, cwd) => {
  const commandEnvironment = { ...process.env };
  for (const providerKey of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "DEEPSEEK_API_KEY",
    "DASHSCOPE_API_KEY",
  ]) {
    delete commandEnvironment[providerKey];
  }
  const processHandle = Bun.spawn(command, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...commandEnvironment,
      GH_PAGER: "cat",
      GH_PROMPT_DISABLED: "true",
    },
  });
  const stdoutPromise = new Response(processHandle.stdout).text();
  const stderrPromise = new Response(processHandle.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      processHandle.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          processHandle.kill();
          reject(
            new Error(`${command[0]} timed out after ${COMMAND_TIMEOUT_MS}ms`),
          );
        }, COMMAND_TIMEOUT_MS);
      }),
    ]);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return { exitCode, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

function linkedIssueIds(body: string): string[] {
  return [
    ...new Set(
      body.match(/\bagent-forge-harness-[a-z0-9]+(?:\.[0-9]+)*\b/gi) ?? [],
    ),
  ].sort();
}

async function loadAcceptanceCriteria(
  ids: string[],
  cwd: string,
  runner: CommandRunner,
): Promise<{ lines: string[]; omissions: string[] }> {
  const lines: string[] = [];
  const omissions: string[] = [];
  for (const id of ids) {
    const command = ["bd", "show", id, "--json"];
    const result = await runner(command, cwd);
    if (result.exitCode !== 0) {
      omissions.push(`Acceptance criteria unavailable for ${id}.`);
      continue;
    }
    try {
      const parsed = JSON.parse(result.stdout) as unknown;
      const issue = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!isRecord(issue) || typeof issue.acceptance_criteria !== "string") {
        omissions.push(`Acceptance criteria missing for ${id}.`);
        continue;
      }
      lines.push(`${id}: ${issue.acceptance_criteria}`);
    } catch {
      omissions.push(`Acceptance criteria invalid for ${id}.`);
    }
  }
  return { lines, omissions };
}

export async function compilePullRequest(
  reference: string,
  options: {
    cwd?: string;
    maxDiffBytes?: number;
    runner?: CommandRunner;
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
  const diffCommand = ["gh", "pr", "diff", safeReference, "--patch"];
  const diffResult = await runner(diffCommand, cwd);
  if (diffResult.exitCode !== 0)
    throw safeCommandError(diffCommand, diffResult);

  const maxDiffBytes = options.maxDiffBytes ?? DEFAULT_DIFF_BYTES;
  if (!Number.isInteger(maxDiffBytes) || maxDiffBytes < 1) {
    throw new Error("maxDiffBytes must be a positive integer");
  }
  const diff = truncateUtf8(diffResult.stdout, maxDiffBytes);
  const issueIds = linkedIssueIds(pullRequest.body);
  const criteria = await loadAcceptanceCriteria(issueIds, cwd, runner);
  const omissions = [...criteria.omissions];
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
    includedFiles: pullRequest.files.map((file) => file.path),
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
