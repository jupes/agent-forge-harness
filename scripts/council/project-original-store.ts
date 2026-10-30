import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  PROJECT_COUNCIL_MAX_JOURNAL_BYTES,
  PROJECT_COUNCIL_MAX_ORIGINAL_BYTES,
  PROJECT_COUNCIL_MAX_ORIGINALS,
  type ProjectCouncilBinding,
  type ProjectCouncilOriginal,
  type ProjectCouncilState,
  projectCouncilIntentJson,
  projectCouncilOriginalSchema,
  projectCouncilShownLabel,
} from "../../types/project-council";
import { ConversationError } from "../conversations/error";
import {
  ensurePrivateHome,
  MAX_BOUNDED_HOME_FILE_BYTES,
  readHomeFile,
  readHomeFileBounded,
} from "../hearth/home-guard";
import { writeOwnerOnly } from "../hearth/token";
import { parseCouncilProfileJson } from "./types";

const JOURNAL_VERSION = 1 as const;
const directoryName = "council-reviews";
const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[a-f0-9]{64}$/;
type Journal = {
  version: typeof JOURNAL_VERSION;
  records: ProjectCouncilOriginal[];
};

export type ProjectCouncilQueueLockResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "busy" | "unusable"; error: string };
export type ProjectCouncilQueueLock = <T>(
  file: string,
  work: () => Promise<T>,
) => Promise<ProjectCouncilQueueLockResult<T>>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function projectCouncilInputHash(value: unknown): string {
  return digest(canonical(value));
}

export function projectCouncilProfileHash(
  profile: ProjectCouncilOriginal["profile"],
): string {
  return digest(canonical(profile));
}

export function projectCouncilRunId(requestId: string): string {
  if (!idPattern.test(requestId))
    throw new ConversationError(
      400,
      "Expected a project Council request UUID.",
    );
  return `council-review-${requestId}`;
}

export function projectCouncilIntentHash(
  original: ProjectCouncilOriginal,
): string {
  return digest(projectCouncilIntentJson(original));
}

function checkedRecord(raw: unknown): ProjectCouncilOriginal | null {
  const parsed = projectCouncilOriginalSchema.safeParse(raw);
  if (!parsed.success) return null;
  const original = parsed.data;
  let profileJson: string;
  try {
    profileJson = JSON.stringify(original.profile);
  } catch {
    return null;
  }
  const profile = parseCouncilProfileJson(profileJson);
  const usedProviders = [
    ...new Set([
      ...original.profile.seats.map((seat) => seat.provider),
      original.profile.chair.provider,
    ]),
  ].sort();
  const endpointsValid =
    original.providerEndpoints.length === usedProviders.length &&
    original.providerEndpoints.every((endpoint, index) => {
      if (endpoint.provider !== usedProviders[index]) return false;
      if (endpoint.provider === "fake")
        return endpoint.transport === "fake" && endpoint.baseUrl === null;
      if (endpoint.baseUrl === null) return false;
      try {
        const url = new URL(endpoint.baseUrl);
        const localHttp =
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        return (
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          (url.protocol === "https:" || localHttp) &&
          endpoint.baseUrl === url.toString().replace(/\/+$/, "")
        );
      } catch {
        return false;
      }
    });
  const evidence = original.context.evidence;
  const evidenceBytes = evidence.reduce(
    (sum, item) => sum + item.byteLength,
    0,
  );
  const contextHashValid =
    original.context.source.kind === "bead"
      ? digest(
          evidence.map((item) => `${item.id}:${item.contentHash}`).join("\n"),
        ) === original.context.contentHash
      : evidence.length === 1 &&
        evidence[0]?.contentHash === original.context.contentHash;
  if (
    !profile.ok ||
    canonical(profile.value) !== canonical(original.profile) ||
    !endpointsValid ||
    projectCouncilRunId(original.requestId) !== original.runId ||
    projectCouncilProfileHash(original.profile) !==
      original.binding.profileHash ||
    projectCouncilIntentHash(original) !== original.intentHash ||
    original.context.byteLength > original.options.maxBytes ||
    evidenceBytes !== original.context.byteLength ||
    evidence.some(
      (item, index) =>
        item.id !== `E${index + 1}` ||
        Buffer.byteLength(item.content, "utf8") !== item.byteLength ||
        digest(item.content) !== item.contentHash,
    ) ||
    !contextHashValid
  )
    return null;
  return { ...original, profile: profile.value };
}

function checkedPaths(home: string, journalHash: string) {
  const directory = join(home, directoryName),
    file = join(directory, `${journalHash}.json`),
    lock = join(directory, `${journalHash}.lock.db`);
  for (const [path, folder] of [
    [directory, true],
    [file, false],
    [lock, false],
  ] as const) {
    try {
      const info = lstatSync(path);
      if (
        info.isSymbolicLink() ||
        (folder ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)
      )
        throw new ConversationError(
          503,
          "The private Council original path is linked or invalid. Saved originals have been kept.",
        );
    } catch (error) {
      if (error instanceof ConversationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ConversationError(
          503,
          "The private Council original path could not be checked.",
        );
    }
  }
  if (readHomeFile(directory).problem !== null)
    throw new ConversationError(
      503,
      "The private Council original directory is not protected. Saved originals have been kept.",
    );
  return { directory, file, lock };
}

function active(original: ProjectCouncilOriginal): boolean {
  return ["reserved", "dispatch-claimed", "running"].includes(original.state);
}

function sameBinding(
  a: ProjectCouncilBinding,
  b: ProjectCouncilBinding,
): boolean {
  return canonical(a) === canonical(b);
}

/**
 * One project/workspace-owned, versioned journal. It retains every identity and body;
 * capacity exhaustion refuses before replacement and never evicts uncertainty.
 */
export function createProjectCouncilOriginalStore(options: {
  home: string;
  workspace: string;
  projectId: string;
  withQueueLock: ProjectCouncilQueueLock;
}) {
  if (!options.workspace || options.workspace.length > 1024)
    throw new ConversationError(400, "Expected a trusted Council workspace.");
  if (
    !/^project-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      options.projectId,
    )
  )
    throw new ConversationError(400, "Expected a trusted Council project.");
  const journalHash = digest(`${options.workspace}\0${options.projectId}`);

  function readState(): Journal {
    const { file } = checkedPaths(options.home, journalHash);
    const found = readHomeFileBounded(
      options.home,
      file,
      MAX_BOUNDED_HOME_FILE_BYTES,
    );
    if (found.problem !== null)
      throw new ConversationError(
        503,
        "The private Council original journal could not be read. Saved originals have been kept.",
      );
    if (found.text === null) return { version: JOURNAL_VERSION, records: [] };
    let raw: unknown;
    try {
      if (
        Buffer.byteLength(found.text, "utf8") >
        PROJECT_COUNCIL_MAX_JOURNAL_BYTES
      )
        throw new Error("Council journal exceeds its byte limit");
      raw = JSON.parse(found.text);
    } catch {
      throw new ConversationError(
        503,
        "The private Council original journal is invalid or full. Saved originals have been kept.",
      );
    }
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      Object.keys(raw).length !== 2 ||
      !("version" in raw) ||
      raw.version !== JOURNAL_VERSION ||
      !("records" in raw) ||
      !Array.isArray(raw.records) ||
      raw.records.length > PROJECT_COUNCIL_MAX_ORIGINALS
    )
      throw new ConversationError(
        503,
        "The private Council original journal is invalid or uses an unsupported version.",
      );
    const records = raw.records.map(checkedRecord);
    const verifiedRecords = records.filter(
      (record): record is ProjectCouncilOriginal => record !== null,
    );
    if (
      verifiedRecords.length !== records.length ||
      new Set(verifiedRecords.map((record) => record.requestId)).size !==
        records.length ||
      verifiedRecords.some(
        (record) =>
          record.binding.workspace !== options.workspace ||
          record.binding.projectId !== options.projectId,
      ) ||
      new Set(
        verifiedRecords
          .filter(active)
          .map(
            (record) =>
              `${record.binding.projectId}\0${record.binding.workspace}`,
          ),
      ).size !== verifiedRecords.filter(active).length ||
      verifiedRecords.some(
        (record) =>
          Buffer.byteLength(JSON.stringify(record), "utf8") >
          PROJECT_COUNCIL_MAX_ORIGINAL_BYTES,
      ) ||
      Buffer.byteLength(JSON.stringify(raw), "utf8") >
        PROJECT_COUNCIL_MAX_JOURNAL_BYTES
    )
      throw new ConversationError(
        503,
        "The private Council original journal failed identity, hash, or size verification. Saved originals have been kept.",
      );
    return {
      version: JOURNAL_VERSION,
      records: verifiedRecords,
    };
  }

  function saveState(state: Journal): void {
    const records = state.records.map(checkedRecord);
    const verifiedRecords = records.filter(
      (record): record is ProjectCouncilOriginal => record !== null,
    );
    if (
      state.version !== JOURNAL_VERSION ||
      state.records.length > PROJECT_COUNCIL_MAX_ORIGINALS ||
      verifiedRecords.length !== records.length ||
      verifiedRecords.some(
        (record) =>
          record.binding.workspace !== options.workspace ||
          record.binding.projectId !== options.projectId,
      ) ||
      new Set(verifiedRecords.map((record) => record.requestId)).size !==
        records.length ||
      new Set(
        verifiedRecords
          .filter(active)
          .map(
            (record) =>
              `${record.binding.projectId}\0${record.binding.workspace}`,
          ),
      ).size !== verifiedRecords.filter(active).length
    )
      throw new ConversationError(
        503,
        "The private Council original journal is invalid or full. No original was changed.",
      );
    const text = JSON.stringify(state);
    if (
      Buffer.byteLength(text, "utf8") > PROJECT_COUNCIL_MAX_JOURNAL_BYTES ||
      verifiedRecords.some(
        (record) =>
          Buffer.byteLength(JSON.stringify(record), "utf8") >
          PROJECT_COUNCIL_MAX_ORIGINAL_BYTES,
      )
    )
      throw new ConversationError(
        503,
        "The private Council original journal reached its verified size limit. No original was changed.",
      );
    ensurePrivateHome(options.home);
    const { directory, file } = checkedPaths(options.home, journalHash);
    mkdirSync(directory, { recursive: true });
    ensurePrivateHome(directory);
    try {
      writeOwnerOnly(file, text);
    } catch {
      throw new ConversationError(
        503,
        "The private Council original write could not be confirmed. Read discovery before retrying.",
      );
    }
    const confirmed = readState();
    if (canonical(confirmed) !== canonical(state))
      throw new ConversationError(
        503,
        "The private Council original could not be verified after writing. Read discovery before retrying.",
      );
  }

  async function locked<T>(
    work: (state: Journal) => Promise<T> | T,
  ): Promise<T> {
    const { lock } = checkedPaths(options.home, journalHash);
    ensurePrivateHome(options.home);
    const result = await options.withQueueLock(lock, async () =>
      work(readState()),
    );
    if (!result.ok)
      throw new ConversationError(
        503,
        "The private Council original journal is busy or unavailable. Read discovery before retrying.",
      );
    return result.value;
  }

  function matchingActive(
    state: Journal,
    projectId: string,
    binding: ProjectCouncilBinding,
    inputHash: string,
  ): ProjectCouncilOriginal | null {
    const found = state.records.find(
      (item) => item.binding.projectId === projectId && active(item),
    );
    if (!found) return null;
    if (
      found.binding.workspace !== options.workspace ||
      !sameBinding(found.binding, binding) ||
      found.inputHash !== inputHash
    )
      throw new ConversationError(
        409,
        "This project already has an unresolved Council original. Read or retire that exact original before preparing a different review.",
      );
    return found;
  }

  return {
    /** Check for the singleton before expensive or mutable source preparation. */
    findActive(
      projectId: string,
      binding: ProjectCouncilBinding,
      inputHash: string,
    ) {
      return locked((state) =>
        matchingActive(state, projectId, binding, inputHash),
      );
    },
    reservePrepared(input: {
      binding: ProjectCouncilBinding;
      inputHash: string;
      profileChoice: string;
      profile: ProjectCouncilOriginal["profile"];
      providerEndpoints: ProjectCouncilOriginal["providerEndpoints"];
      context: ProjectCouncilOriginal["context"];
      listing: string[];
      options: ProjectCouncilOriginal["options"];
    }) {
      return locked((state) => {
        const existing = matchingActive(
          state,
          input.binding.projectId,
          input.binding,
          input.inputHash,
        );
        if (existing) return { original: existing, created: false };
        if (state.records.length >= PROJECT_COUNCIL_MAX_ORIGINALS)
          throw new ConversationError(
            503,
            "The private Council original journal is full. Saved identities have been kept.",
          );
        const requestId = randomUUID().toLowerCase(),
          now = new Date().toISOString();
        const original: ProjectCouncilOriginal = {
          requestId,
          runId: projectCouncilRunId(requestId),
          inputHash: input.inputHash,
          intentHash: "0".repeat(64),
          binding: { ...input.binding },
          profileChoice: input.profileChoice,
          profile: structuredClone(input.profile),
          providerEndpoints: structuredClone(input.providerEndpoints),
          context: structuredClone(input.context),
          listing: [...input.listing],
          options: { ...input.options },
          state: "reserved",
          createdAt: now,
          updatedAt: now,
          dispatchClaimedAt: null,
        };
        original.intentHash = projectCouncilIntentHash(original);
        if (checkedRecord(original) === null)
          throw new ConversationError(
            400,
            "The prepared Council original failed strict verification and was not saved.",
          );
        state.records.push(original);
        saveState(state);
        return { original: structuredClone(original), created: true };
      });
    },
    discover(projectId: string): ProjectCouncilOriginal | null {
      if (projectId !== options.projectId) return null;
      const state = readState();
      return (
        state.records.find(
          (item) =>
            item.binding.projectId === projectId &&
            item.binding.workspace === options.workspace &&
            active(item),
        ) ?? null
      );
    },
    history(projectId: string, limit = 100) {
      if (projectId !== options.projectId)
        return {
          version: 1 as const,
          projectId: options.projectId,
          workspace: options.workspace,
          activeRequestId: null,
          total: 0,
          omitted: 0,
          items: [],
        };
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new ConversationError(
          400,
          "Expected a bounded Council history limit.",
        );
      const state = readState();
      const activeRequestId =
        state.records.find(
          (item) =>
            item.binding.projectId === projectId &&
            item.binding.workspace === options.workspace &&
            active(item),
        )?.requestId ?? null;
      const rows = state.records
        .filter(
          (item) =>
            item.binding.projectId === projectId &&
            item.binding.workspace === options.workspace,
        )
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) ||
            b.createdAt.localeCompare(a.createdAt),
        );
      const total = rows.length;
      return {
        version: 1 as const,
        projectId: options.projectId,
        workspace: options.workspace,
        activeRequestId,
        total,
        omitted: Math.max(0, total - limit),
        items: rows.slice(0, limit).map((item) => ({
          requestId: item.requestId,
          runId: item.runId,
          intentHash: item.intentHash,
          state: item.state,
          phase: item.state === "dispatch-claimed" ? "unknown" : item.state,
          sourceType:
            item.context.source.kind === "stdin"
              ? "text"
              : item.context.source.kind,
          sourceName: projectCouncilShownLabel(item.context.source.displayName),
          profileId: item.profile.id,
          profileTitle: projectCouncilShownLabel(item.profile.title),
          depth: item.profile.depth,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        })),
      };
    },
    read(projectId: string, requestId: string): ProjectCouncilOriginal {
      if (!idPattern.test(requestId))
        throw new ConversationError(
          400,
          "Expected a project Council request UUID.",
        );
      const found = readState().records.find(
        (item) => item.requestId === requestId,
      );
      if (!found)
        throw new ConversationError(
          404,
          "This Council original is not retained.",
        );
      if (
        found.binding.projectId !== projectId ||
        found.binding.workspace !== options.workspace
      )
        throw new ConversationError(
          404,
          "This Council original is not in this project.",
        );
      return found;
    },
    retire(projectId: string, requestId: string, intentHash: string) {
      return locked((state) => {
        const original = state.records.find(
          (item) => item.requestId === requestId,
        );
        if (!original)
          throw new ConversationError(
            404,
            "This Council original is not retained.",
          );
        if (
          original.binding.projectId !== projectId ||
          original.binding.workspace !== options.workspace
        )
          throw new ConversationError(
            404,
            "This Council original is not in this project.",
          );
        if (original.intentHash !== intentHash)
          throw new ConversationError(
            409,
            "The Council original hash does not match.",
          );
        if (original.state !== "reserved")
          throw new ConversationError(
            409,
            "Only an uncommitted Council original can be retired.",
          );
        original.state = "retired";
        original.updatedAt = new Date().toISOString();
        saveState(state);
        return structuredClone(original);
      });
    },
    claimDispatch(
      projectId: string,
      requestId: string,
      intentHash: string,
      validate: (original: ProjectCouncilOriginal) => Promise<void>,
    ) {
      return locked(async (state) => {
        const original = state.records.find(
          (item) => item.requestId === requestId,
        );
        if (!original)
          throw new ConversationError(
            404,
            "This Council original is not retained.",
          );
        if (
          original.binding.projectId !== projectId ||
          original.binding.workspace !== options.workspace
        )
          throw new ConversationError(
            404,
            "This Council original is not in this project.",
          );
        if (original.intentHash !== intentHash)
          throw new ConversationError(
            409,
            "The Council original hash does not match.",
          );
        if (original.state !== "reserved")
          return { original: structuredClone(original), created: false };
        await validate(original);
        original.state = "dispatch-claimed";
        original.dispatchClaimedAt = new Date().toISOString();
        original.updatedAt = original.dispatchClaimedAt;
        saveState(state);
        return { original: structuredClone(original), created: true };
      });
    },
    setTerminal(
      projectId: string,
      requestId: string,
      intentHash: string,
      stateName: Extract<
        ProjectCouncilState,
        "completed" | "failed" | "cancelled"
      >,
    ) {
      return locked((state) => {
        const original = state.records.find(
          (item) => item.requestId === requestId,
        );
        if (!original)
          throw new ConversationError(
            404,
            "This Council original is not retained.",
          );
        if (
          original.binding.projectId !== projectId ||
          original.binding.workspace !== options.workspace ||
          original.intentHash !== intentHash
        )
          throw new ConversationError(
            409,
            "The original Council identity changed.",
          );
        if (
          original.state !== "dispatch-claimed" &&
          original.state !== "running"
        )
          return structuredClone(original);
        original.state = stateName;
        original.updatedAt = new Date().toISOString();
        saveState(state);
        return structuredClone(original);
      });
    },
    markRunning(projectId: string, requestId: string, intentHash: string) {
      return locked((state) => {
        const original = state.records.find(
          (item) => item.requestId === requestId,
        );
        if (!original || original.binding.projectId !== projectId)
          throw new ConversationError(
            404,
            "This Council original is not retained.",
          );
        if (original.intentHash !== intentHash)
          throw new ConversationError(
            409,
            "The Council original hash does not match.",
          );
        if (original.state === "dispatch-claimed") {
          original.state = "running";
          original.updatedAt = new Date().toISOString();
          saveState(state);
        }
        return structuredClone(original);
      });
    },
  };
}
