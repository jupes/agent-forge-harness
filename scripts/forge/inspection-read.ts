/** Read-only, bounded source boundary. Never migrates, repairs or writes a run. */
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  opendirSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { FORGE_PHASES } from "./phases";
import {
  comparableCheckout,
  isValidSlug,
  parseState,
  runSlugFromFilename,
} from "./runs";

export const RUN_INSPECTION_LIMITS = {
  files: 128,
  fileBytes: 512 * 1024,
  totalBytes: 8 * 1024 * 1024,
  directoryEntries: 1024,
  reviews: 256,
  gateDays: 30,
  gateFileBytes: 2 * 1024 * 1024,
} as const;

const text = z
  .string()
  .max(2048)
  .refine((value) => !/[\p{Cc}\p{Cs}]/u.test(value));
const phase = z.enum(FORGE_PHASES);
const review = z
  .object({
    phase,
    round: z.number().int().positive().max(RUN_INSPECTION_LIMITS.reviews),
    verdict: z.enum(["PASS", "FAIL", "UNREADABLE"]),
    findings: z
      .object({
        blocker: z.number().int().nonnegative().max(1_000_000),
        high: z.number().int().nonnegative().max(1_000_000),
        medium: z.number().int().nonnegative().max(1_000_000),
        low: z.number().int().nonnegative().max(1_000_000),
      })
      .strict(),
    tier: text.max(200).optional(),
    verdictSchemaVersion: z.union([z.literal(1), z.literal(2)]).optional(),
    verdictSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    summary: z.string().max(2048).optional(),
    action: z.enum(["advance", "revise", "halt"]).optional(),
    reason: text.optional(),
    verdictError: text.optional(),
    at: z.iso.datetime(),
  })
  .strict();

/** Strict input around the canonical ForgeState; the canonical selectors still decide behavior. */
const storedRun = z
  .object({
    schemaVersion: z.literal(2).optional(),
    slug: text.refine(isValidSlug),
    feature: text.optional(),
    phase,
    completed: z
      .array(phase)
      .max(4)
      .refine((items) => new Set(items).size === items.length),
    epic: text.max(256).optional(),
    beadId: text.max(256).optional(),
    executor: z
      .object({
        provider: text.max(200).min(1),
        model: text.max(200).min(1),
        effort: text.max(200).optional(),
        smith: text.max(200).optional(),
        sessionId: text.max(256).optional(),
      })
      .strict()
      .optional(),
    artifacts: z.partialRecord(phase, text.max(1024)),
    reviews: z.array(review).max(RUN_INSPECTION_LIMITS.reviews).optional(),
    announcedPhase: phase.optional(),
    announcedStatus: z
      .enum(["clear", "awaiting-review", "revise", "halted"])
      .optional(),
    mode: z.enum(["gated", "auto"]).optional(),
    checkout: text.max(1024).optional(),
    updatedAt: z.iso.datetime(),
  })
  .strict();

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";
const samePath = (a: string, b: string) =>
  comparableCheckout(a) === comparableCheckout(b);

export class RunInspectionError extends Error {
  constructor(
    message = "Run source is unavailable, changed, linked or exceeds its inspection bounds.",
  ) {
    super(message);
  }
}

function entries(path: string) {
  const stream = opendirSync(path);
  const names: string[] = [];
  try {
    for (;;) {
      const next = stream.readSync();
      if (!next) return names;
      names.push(next.name);
      if (names.length > RUN_INSPECTION_LIMITS.directoryEntries)
        throw new RunInspectionError();
    }
  } finally {
    stream.closeSync();
  }
}

/** Captures the served root identity; a stored checkout never chooses an I/O root. */
export function createRunInspectionReader(root: string) {
  const selected = resolve(root);
  const canonical = realpathSync.native(selected);
  const identity = lstatSync(canonical, { bigint: true });
  if (identity.ino === 0n || !identity.isDirectory())
    throw new RunInspectionError();
  function checkRoot() {
    const current = lstatSync(canonical, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      !samePath(realpathSync.native(selected), canonical)
    )
      throw new RunInspectionError();
  }
  function directory(parts: readonly string[]): string | null {
    checkRoot();
    let path = canonical;
    for (const part of parts) {
      path = join(path, part);
      let info: Stats;
      try {
        info = lstatSync(path);
      } catch (error) {
        if (missing(error)) return null;
        throw new RunInspectionError();
      }
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        !samePath(realpathSync.native(path), path)
      )
        throw new RunInspectionError();
    }
    return path;
  }
  function file(parts: readonly string[], maxBytes: number): string | null {
    const folder = directory(parts.slice(0, -1));
    if (!folder) return null;
    const path = join(folder, parts.at(-1) ?? "");
    let fd: number | undefined;
    try {
      const named = lstatSync(path, { bigint: true });
      if (
        !named.isFile() ||
        named.ino === 0n ||
        named.isSymbolicLink() ||
        named.nlink !== 1n ||
        named.size > BigInt(maxBytes) ||
        !samePath(realpathSync.native(path), path)
      )
        throw new RunInspectionError();
      fd = openSync(
        path,
        constants.O_RDONLY |
          (constants.O_NOFOLLOW ?? 0) |
          (constants.O_NONBLOCK ?? 0),
      );
      const opened = fstatSync(fd, { bigint: true });
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        opened.dev !== named.dev ||
        opened.ino !== named.ino ||
        opened.size !== named.size
      )
        throw new RunInspectionError();
      const bytes = Buffer.alloc(Number(opened.size) + 1);
      let length = 0;
      while (length < bytes.length) {
        const next = readSync(fd, bytes, length, bytes.length - length, null);
        if (!next) break;
        length += next;
      }
      const after = fstatSync(fd, { bigint: true });
      const current = lstatSync(path, { bigint: true });
      if (
        length !== Number(opened.size) ||
        after.size !== opened.size ||
        after.mtimeNs !== opened.mtimeNs ||
        after.ctimeNs !== opened.ctimeNs ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino ||
        current.nlink !== 1n ||
        current.mtimeNs !== opened.mtimeNs ||
        current.ctimeNs !== opened.ctimeNs ||
        current.isSymbolicLink() ||
        !current.isFile()
      )
        throw new RunInspectionError();
      if (!directory(parts.slice(0, -1))) throw new RunInspectionError();
      return new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(0, length),
      );
    } catch (error) {
      if (missing(error) && fd === undefined) return null;
      throw new RunInspectionError();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  return {
    checkout: canonical,
    read() {
      const folder = directory([".tmp", "work", "forge-runs"]);
      if (!folder) return [];
      const names = entries(folder).filter((name) => name.endsWith(".json"));
      if (names.length > RUN_INSPECTION_LIMITS.files)
        throw new RunInspectionError();
      let bytes = 0;
      const states = names.map((name) => {
        const slug = runSlugFromFilename(name);
        if (!slug) throw new RunInspectionError();
        const source = file(
          [".tmp", "work", "forge-runs", name],
          RUN_INSPECTION_LIMITS.fileBytes,
        );
        if (source === null) throw new RunInspectionError();
        bytes += Buffer.byteLength(source);
        if (bytes > RUN_INSPECTION_LIMITS.totalBytes)
          throw new RunInspectionError();
        let raw: unknown;
        try {
          raw = JSON.parse(source);
        } catch {
          throw new RunInspectionError();
        }
        const checked = storedRun.safeParse(raw);
        if (!checked.success || checked.data.slug !== slug)
          throw new RunInspectionError();
        const canonicalState = parseState(source);
        if (!canonicalState) throw new RunInspectionError();
        return canonicalState;
      });
      checkRoot();
      return states;
    },
    /** The separate trusted gate-log root uses the same checked file boundary. */
    gateLogs() {
      checkRoot();
      const days = entries(canonical)
        .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
        .sort()
        .reverse()
        .slice(0, RUN_INSPECTION_LIMITS.gateDays);
      let bytes = 0;
      const logs = days.flatMap((day) => {
        const log = file(
          [day, "quality-gate.jsonl"],
          RUN_INSPECTION_LIMITS.gateFileBytes,
        );
        if (log === null) return [];
        bytes += Buffer.byteLength(log);
        if (bytes > RUN_INSPECTION_LIMITS.totalBytes)
          throw new RunInspectionError();
        return [log];
      });
      checkRoot();
      return logs;
    },
    artifactExists(relative: string) {
      try {
        const parts = relative.split("/");
        const folder = directory(parts.slice(0, -1));
        if (!folder) return false;
        const path = join(folder, parts.at(-1) ?? "");
        const info = lstatSync(path);
        return (
          info.isFile() &&
          !info.isSymbolicLink() &&
          info.nlink === 1 &&
          samePath(realpathSync.native(path), path)
        );
      } catch {
        return false;
      }
    },
  };
}

export function readInspectionGateLogs(root: string): string[] {
  try {
    return createRunInspectionReader(root).gateLogs();
  } catch (error) {
    if (missing(error)) return [];
    throw error instanceof RunInspectionError
      ? error
      : new RunInspectionError();
  }
}
