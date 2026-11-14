import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { projectCheckpointReviewScopeSchema } from "../../types/project-checkpoint-reviews";
import {
  projectCheckpointSourceContextReadSchema,
  projectCheckpointSourceInventorySchema,
} from "../../types/project-checkpoint-source-context";
import {
  type ProjectCheckpointSubmissionOriginal,
  projectCheckpointSubmissionOriginalJson,
  projectCheckpointSubmissionOriginalSchema,
  projectCheckpointSubmissionRecordSchema,
  projectCheckpointSubmissionScope,
} from "../../types/project-checkpoint-submissions";
import { hearthHome, lockPath, tokenPath } from "../hearth/home";
import { readHomeLock } from "../hearth/home-guard";
import { type HearthLock, isPidAlive, sameLock } from "../hearth/lock";
import {
  type Exchange,
  healthProblem,
  loopbackExchange,
} from "../hearth/loopback";
import { API_PREFIX, OPERATOR_HEADER, SURFACE_HEADER } from "../hearth/paths";
import { readToken } from "../hearth/token";
import { isMain } from "../is-main";
import { workspaceKey } from "../projects/scope";
import { canonicalTrustedDirectory } from "../trusted-directory";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.uuid().refine((value) => value === value.toLowerCase());
const scopeSchema = projectCheckpointReviewScopeSchema.omit({
  workspacePath: true,
});
export type CheckpointSourceCommand = {
  command: "context" | "draft-publish" | "draft-withdraw" | "apply" | "recover";
  root: string;
  projectId?: string;
  runSlug?: string;
  beadId?: string;
  requestId?: string;
  targetRequestId?: string;
  targetHash?: string;
  file?: string;
  hash?: string;
};
export function parseCheckpointSourceArgs(
  argv: readonly string[],
): CheckpointSourceCommand {
  const command = argv[0];
  if (
    command !== "context" &&
    command !== "draft-publish" &&
    command !== "draft-withdraw" &&
    command !== "apply" &&
    command !== "recover"
  )
    throw Error("Expected a checkpoint source command.");
  const allowed = new Set(
    command === "apply" || command === "recover"
      ? ["root", "file", "hash"]
      : [
          "root",
          "project",
          "run",
          "bead",
          ...(command === "context" ? [] : ["request-id"]),
          ...(command === "draft-withdraw"
            ? ["target-request-id", "target-hash"]
            : []),
        ],
  );
  const flags: Record<string, string> = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index],
      value = argv[index + 1];
    if (
      !flag?.startsWith("--") ||
      !allowed.has(flag.slice(2)) ||
      Object.hasOwn(flags, flag.slice(2)) ||
      !value ||
      value.startsWith("--") ||
      /[<>]/.test(value) ||
      [...value].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    )
      throw Error("Expected unique supported flags with explicit values.");
    flags[flag.slice(2)] = value;
  }
  if ([...allowed].some((key) => flags[key] === undefined))
    throw Error("Every command flag is required.");
  const root = flags["root"]!;
  if (!root.startsWith("/") && !/^[a-z]:[\\/]/i.test(root))
    throw Error("Expected an absolute checkout root.");
  if (command === "apply" || command === "recover")
    return {
      command,
      root,
      file: flags["file"]!,
      hash: hash.parse(flags["hash"]),
    };
  const scope = scopeSchema.parse({
    projectId: flags["project"],
    runSlug: flags["run"],
    beadId: flags["bead"],
  });
  return {
    command,
    root,
    ...scope,
    ...(command === "context"
      ? {}
      : { requestId: uuid.parse(flags["request-id"]) }),
    ...(command === "draft-withdraw"
      ? {
          targetRequestId: uuid.parse(flags["target-request-id"]),
          targetHash: hash.parse(flags["target-hash"]),
        }
      : {}),
  };
}

type Request = { method: "GET" | "POST"; target: string; body?: string };
type Answer = { status: number; body: string };
type Send = (request: Request) => Promise<Answer>;
type Envelope = { ok: boolean; data: unknown; error: string | null };
export interface CheckpointSourcePorts {
  connect(root: string): Promise<Send>;
  readFile(file: string): Promise<string>;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => JSON.stringify(key) + ":" + canonical(item))
        .join(",") +
      "}"
    );
  const result = JSON.stringify(value);
  if (result === undefined) throw Error("Expected JSON data.");
  return result;
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const ok = (data: unknown): Envelope => ({ ok: true, data, error: null });
const draftSchema = z
  .object({
    ok: z.literal(true),
    data: z
      .object({
        original: projectCheckpointSubmissionOriginalSchema,
        originalHash: hash,
      })
      .strict(),
    error: z.null(),
  })
  .strict();
export const checkpointSourceArtifactJson = canonical;
function envelope(answer: Answer): unknown {
  if (Buffer.byteLength(answer.body) > 3 * 1024 * 1024)
    throw Error("Response too large.");
  let raw: unknown;
  try {
    raw = JSON.parse(answer.body);
  } catch {
    throw Error("Invalid operator reply.");
  }
  const parsed = z
    .object({
      ok: z.boolean(),
      data: z.unknown(),
      error: z.string().nullable(),
    })
    .strict()
    .parse(raw);
  if (answer.status !== 200 || !parsed.ok || parsed.error !== null)
    throw Error("The operator result could not be verified.");
  return parsed.data;
}
function verifiedRecord(
  value: unknown,
  originalHash: string,
  original?: ProjectCheckpointSubmissionOriginal,
) {
  const row = projectCheckpointSubmissionRecordSchema.parse(value);
  if (
    row.originalHash !== originalHash ||
    digest(projectCheckpointSubmissionOriginalJson(row.original)) !==
      originalHash ||
    (original &&
      projectCheckpointSubmissionOriginalJson(row.original) !==
        projectCheckpointSubmissionOriginalJson(original))
  )
    throw Error("The exact source original could not be verified.");
  const reviewHash =
    row.original.kind === "publish"
      ? digest(
          canonical({
            family: "checkpoint-source-submission",
            schemaVersion: 1,
            originalHash,
          }),
        )
      : null;
  if (row.receipt.reviewScopeHash !== reviewHash)
    throw Error("The source receipt could not be verified.");
  return row;
}
function readDraft(raw: string, expectedHash: string) {
  if (Buffer.byteLength(raw) > 128 * 1024)
    throw Error("Saved draft too large.");
  const text = raw.replace(/^\uFEFF/, "").replace(/(?:\r\n|\n)$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Error("Invalid saved draft.");
  }
  const draft = draftSchema.parse(parsed);
  if (
    canonical(draft) !== text ||
    draft.data.originalHash !== expectedHash ||
    digest(projectCheckpointSubmissionOriginalJson(draft.data.original)) !==
      expectedHash
  )
    throw Error("Expected the exact saved canonical draft and reviewed hash.");
  return draft.data.original;
}
function pathFor(scope: {
  projectId: string;
  runSlug: string;
  beadId: string;
}) {
  return (
    "/projects/" +
    encodeURIComponent(scope.projectId) +
    "/runs/" +
    encodeURIComponent(scope.runSlug) +
    "/checkpoints/" +
    encodeURIComponent(scope.beadId)
  );
}
async function readSavedFile(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 128 * 1024)
      throw Error("Expected a bounded saved draft file.");
    const buffer = Buffer.alloc(128 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      length > 128 * 1024 ||
      length !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw Error("The saved draft changed during its read.");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, length),
    );
  } finally {
    await handle.close();
  }
}
export interface CheckpointSourceConnectionPorts {
  home?: string;
  canonicalRoot?(root: string): string;
  readLock?: typeof readHomeLock;
  readToken?: typeof readToken;
  alive?: typeof isPidAlive;
  health?: typeof healthProblem;
  exchange?: Exchange;
}
export async function connectCheckpointSource(
  requestedRoot: string,
  ports: CheckpointSourceConnectionPorts = {},
): Promise<Send> {
  const root = ports.canonicalRoot
    ? ports.canonicalRoot(requestedRoot)
    : (() => {
        const root = canonicalTrustedDirectory(requestedRoot);
        const info = lstatSync(root);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw Error("Expected an existing plain checkout.");
        return root;
      })();
  const home = ports.home ?? hearthHome();
  const read = ports.readLock ?? readHomeLock;
  const file = lockPath(home, root);
  const checked = (): HearthLock => {
    const value = read(home, file);
    const lock = value.lock;
    if (
      value.problem !== null ||
      !lock ||
      workspaceKey(resolve(lock.root)) !== workspaceKey(resolve(root)) ||
      !Number.isInteger(lock.port) ||
      lock.port < 1 ||
      lock.port > 65535 ||
      !(ports.alive ?? isPidAlive)(lock.pid) ||
      workspaceKey(resolve(lock.tokenFile)) !==
        workspaceKey(resolve(tokenPath(home, root)))
    )
      throw Error("The checkout operator connection is unavailable.");
    return lock;
  };
  const lock = checked();
  const exchange = ports.exchange ?? loopbackExchange;
  if (
    (await (ports.health ?? healthProblem)(lock, { exchange })) !== null ||
    !sameLock(checked(), lock)
  )
    throw Error("The checkout operator identity changed.");
  return async (request) => {
    if (!sameLock(checked(), lock))
      throw Error("The checkout operator identity changed.");
    const token = (ports.readToken ?? readToken)(tokenPath(home, root));
    if (!token || !/^[a-f0-9]{64}$/.test(token) || !sameLock(checked(), lock))
      throw Error("The checkout operator token is unavailable.");
    return exchange({
      port: lock.port,
      method: request.method,
      target: API_PREFIX + request.target,
      headers: {
        Origin: "http://127.0.0.1:" + lock.port,
        [OPERATOR_HEADER]: token,
        [SURFACE_HEADER]: "cli",
        ...(request.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(request.body ? { body: request.body } : {}),
      timeoutMs: 45000,
      maxBytes: 3 * 1024 * 1024,
    });
  };
}
export async function runCheckpointSource(
  argv: readonly string[],
  injected: Partial<CheckpointSourcePorts> = {},
): Promise<Envelope> {
  try {
    const command = parseCheckpointSourceArgs(argv);
    const connect = injected.connect ?? connectCheckpointSource;
    if (command.command === "apply" || command.command === "recover") {
      const original = readDraft(
        await (injected.readFile ?? readSavedFile)(command.file!),
        command.hash!,
      );
      const scope = projectCheckpointSubmissionScope(original);
      const send = await connect(command.root);
      const target = pathFor(scope) + "/source-submissions";
      try {
        const answer = await send(
          command.command === "recover"
            ? { method: "GET", target: target + "/" + original.requestId }
            : {
                method: "POST",
                target:
                  target + (original.kind === "withdraw" ? "/withdraw" : ""),
                body: projectCheckpointSubmissionOriginalJson(original),
              },
        );
        if (command.command === "recover" && answer.status === 404)
          return ok({
            state: "unknown",
            observation: "not-observed",
            requestId: original.requestId,
            originalHash: command.hash,
          });
        const data = envelope(answer);
        const row = verifiedRecord(
          command.command === "apply"
            ? z
                .object({ created: z.boolean(), record: z.unknown() })
                .strict()
                .parse(data).record
            : data,
          command.hash!,
          original,
        );
        return ok({ state: "historically-applied", record: row });
      } catch {
        return ok({
          state: "unknown",
          requestId: original.requestId,
          originalHash: command.hash,
          instruction:
            "Recover this exact saved original; do not create or automatically resend a replacement.",
        });
      }
    }
    const scope = scopeSchema.parse({
      projectId: command.projectId,
      runSlug: command.runSlug,
      beadId: command.beadId,
    });
    const send = await connect(command.root),
      base = pathFor(scope);
    if (command.command === "context" || command.command === "draft-publish") {
      const context = projectCheckpointSourceContextReadSchema.parse(
        envelope(
          await send({ method: "GET", target: base + "/source-context" }),
        ),
      );
      if (context.available) {
        const binding = context.context.baseBinding;
        if (
          binding.projectId !== scope.projectId ||
          binding.runSlug !== scope.runSlug ||
          binding.beadId !== scope.beadId
        )
          throw Error("The checked source belongs to another scope.");
      }
      if (command.command === "context") return ok(context);
      if (!context.available || context.context.state === "foreign")
        throw Error("Checked source is unavailable.");
      const binding = context.context.baseBinding;
      if (
        binding.projectId !== scope.projectId ||
        binding.runSlug !== scope.runSlug ||
        binding.beadId !== scope.beadId
      )
        throw Error("The checked source belongs to another scope.");
      const original = projectCheckpointSubmissionOriginalSchema.parse({
        schemaVersion: 1,
        kind: "publish",
        requestId: command.requestId,
        binding,
        sourceVersion: context.context.sourceVersion,
        expectedSubmissionGeneration: context.context.generation,
      });
      return ok({
        original,
        originalHash: digest(projectCheckpointSubmissionOriginalJson(original)),
      });
    }
    const inventory = projectCheckpointSourceInventorySchema.parse(
      envelope(
        await send({ method: "GET", target: base + "/source-submissions" }),
      ),
    );
    if (
      inventory.blocked ||
      inventory.currentRequestId !== command.targetRequestId
    )
      throw Error("The target is not the exact current source.");
    const row = verifiedRecord(
      envelope(
        await send({
          method: "GET",
          target: base + "/source-submissions/" + command.targetRequestId,
        }),
      ),
      command.targetHash!,
    );
    const targetScope = projectCheckpointSubmissionScope(row.original);
    if (
      row.original.requestId !== command.targetRequestId ||
      row.original.kind !== "publish" ||
      targetScope.projectId !== scope.projectId ||
      targetScope.runSlug !== scope.runSlug ||
      targetScope.beadId !== scope.beadId ||
      row.receipt.resultingGeneration !== inventory.generation ||
      !inventory.items.some(
        (item) =>
          item.originalHash === row.originalHash &&
          canonical(item) === canonical(row),
      )
    )
      throw Error("The target source changed.");
    const original = projectCheckpointSubmissionOriginalSchema.parse({
      schemaVersion: 1,
      kind: "withdraw",
      requestId: command.requestId,
      scope: targetScope,
      targetSubmissionRequestId: command.targetRequestId,
      targetOriginalHash: command.targetHash,
      expectedSubmissionGeneration: inventory.generation,
    });
    return ok({
      original,
      originalHash: digest(projectCheckpointSubmissionOriginalJson(original)),
    });
  } catch {
    return {
      ok: false,
      data: null,
      error:
        "The checkpoint source request could not be verified. No automatic retry was made.",
    };
  }
}
if (isMain(import.meta)) {
  const answer = await runCheckpointSource(process.argv.slice(2));
  process.stdout.write(canonical(answer) + "\n");
  if (!answer.ok) process.exitCode = 2;
  else if (
    typeof answer.data === "object" &&
    answer.data !== null &&
    "state" in answer.data &&
    answer.data.state === "unknown"
  )
    process.exitCode = 1;
}
