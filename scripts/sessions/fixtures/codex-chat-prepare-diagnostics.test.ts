import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markReadOnlyCapabilityRefusal } from "../read-only-capability-refusal";
import {
  CODEX_CHAT_PREPARE_FACTS_FILE,
  CODEX_CHAT_PREPARE_FACTS_MAX_BYTES,
  CODEX_CHAT_PREPARE_FACTS_MAX_ROWS,
  CODEX_CHAT_PREPARE_MARKER_FILE,
  classifyProbePhase,
  createCodexChatPrepareDiagnostics,
  createFilePrepareDiagnosticIo,
  initializePrepareDiagnosticFiles,
  type PrepareDiagnosticIo,
  type PrepareFact,
  recordProbeFact,
} from "./codex-chat-prepare-diagnostics";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "codex-chat-prepare-facts-"));
  homes.push(home);
  writeFileSync(
    join(home, CODEX_CHAT_PREPARE_MARKER_FILE),
    JSON.stringify({ version: 1, state: "idle" }),
  );
  writeFileSync(join(home, CODEX_CHAT_PREPARE_FACTS_FILE), "");
  return home;
}

test("preparation probe phase reports only the last completed bounded phase", () => {
  const probe = (
    ordinal: number,
    name: "version" | "help",
    event: "started" | "completed",
  ) => ({
    version: 1 as const,
    source: "probe" as const,
    ordinal,
    correlation: "single" as const,
    probe: name,
    event,
  });
  expect(classifyProbePhase({ state: "unavailable" }, 1)).toBe("unknown");
  expect(classifyProbePhase({ state: "available", facts: [] }, 1)).toBe(
    "before-probes-or-unobserved",
  );
  expect(
    classifyProbePhase(
      { state: "available", facts: [probe(1, "version", "started")] },
      1,
    ),
  ).toBe("version-probe");
  expect(
    classifyProbePhase(
      { state: "available", facts: [probe(1, "version", "completed")] },
      1,
    ),
  ).toBe("between-probes");
  expect(
    classifyProbePhase(
      { state: "available", facts: [probe(1, "help", "started")] },
      1,
    ),
  ).toBe("help-probe");
  expect(
    classifyProbePhase(
      {
        state: "available",
        facts: [
          probe(1, "version", "completed"),
          probe(1, "help", "completed"),
        ],
      },
      1,
    ),
  ).toBe("after-probes");
  expect(
    classifyProbePhase(
      {
        state: "available",
        facts: [
          {
            version: 1,
            source: "probe",
            event: "started",
            probe: "version",
            correlation: "overlap",
          },
        ],
      },
      1,
    ),
  ).toBe("unknown");
});

test("failure facts identify bounded prepare phase without copying the error", async () => {
  const facts: PrepareFact[] = [];
  let now = 50;
  const io: PrepareDiagnosticIo = {
      now: () => now,
      writeMarker() {},
      appendFact: (fact) => facts.push(fact),
      readFacts: () => ({ state: "available", facts }),
    },
    diagnostics = createCodexChatPrepareDiagnostics(io),
    original = markReadOnlyCapabilityRefusal(
      new Error("private diagnostic text"),
    );
  await expect(
    diagnostics.observe("prepare", async () => {
      facts.push(
        {
          version: 1,
          source: "probe",
          event: "started",
          probe: "version",
          correlation: "single",
          ordinal: 1,
        },
        {
          version: 1,
          source: "probe",
          event: "completed",
          probe: "version",
          correlation: "single",
          ordinal: 1,
        },
        {
          version: 1,
          source: "probe",
          event: "started",
          probe: "help",
          correlation: "single",
          ordinal: 1,
        },
        {
          version: 1,
          source: "probe",
          event: "completed",
          probe: "help",
          correlation: "single",
          ordinal: 1,
        },
      );
      now = 130;
      throw original;
    }),
  ).rejects.toBe(original);
  const failed = facts.find(
    (fact) => fact.source === "runtime" && fact.event === "settled",
  );
  expect(failed).toMatchObject({
    outcome: "failure",
    phase: "after-probes",
    elapsedMs: 80,
    errorClass: "capability-refusal",
  });
  expect(JSON.stringify(failed)).not.toContain("private diagnostic text");
});

test("overlapping operations stay unattributed until the full cohort ends", async () => {
  const home = newHome(),
    io = createFilePrepareDiagnosticIo(home, (path, content) =>
      writeFileSync(path, content),
    ),
    diagnostics = createCodexChatPrepareDiagnostics(io);
  let releasePrepare!: () => void, releaseCheck!: () => void;
  const prepareGate = new Promise<void>(
      (resolve) => (releasePrepare = resolve),
    ),
    checkGate = new Promise<void>((resolve) => (releaseCheck = resolve)),
    preparing = diagnostics.observe("prepare", () => prepareGate),
    checking = diagnostics.observe("check", () => checkGate);

  expect(diagnostics.activeMarker()).toMatchObject({ state: "overlap" });
  recordProbeFact(home, "version", "started");
  let rows = readFileSync(join(home, CODEX_CHAT_PREPARE_FACTS_FILE), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(rows.at(-1)).toMatchObject({
    source: "probe",
    correlation: "overlap",
  });
  expect(rows.at(-1)).not.toHaveProperty("ordinal");

  releaseCheck();
  await checking;
  expect(diagnostics.activeMarker()).toMatchObject({ state: "overlap" });
  recordProbeFact(home, "help", "started");
  rows = readFileSync(join(home, CODEX_CHAT_PREPARE_FACTS_FILE), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(rows.at(-1)).toMatchObject({
    source: "probe",
    correlation: "overlap",
  });
  expect(rows.at(-1)).not.toHaveProperty("ordinal");

  releasePrepare();
  await preparing;
  expect(diagnostics.activeMarker()).toMatchObject({ state: "idle" });
});

test("an operation that overlaps later settles unknown for the whole cohort", async () => {
  const facts: PrepareFact[] = [];
  let releaseFirst!: () => void, releaseSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve)),
    secondGate = new Promise<void>((resolve) => (releaseSecond = resolve)),
    diagnostics = createCodexChatPrepareDiagnostics({
      now: () => 1,
      writeMarker() {},
      appendFact: (fact) => facts.push(fact),
      readFacts: () => ({ state: "available", facts }),
    }),
    first = diagnostics.observe("prepare", () => firstGate);
  facts.push({
    version: 1,
    source: "probe",
    event: "completed",
    probe: "version",
    correlation: "single",
    ordinal: 1,
    elapsedMs: 1,
  });
  const second = diagnostics.observe("check", () => secondGate);

  releaseFirst();
  await first;
  const firstSettled = facts.find(
    (fact) =>
      fact.source === "runtime" &&
      fact.event === "settled" &&
      fact.ordinal === 1,
  );
  expect(firstSettled).toMatchObject({ phase: "unknown" });

  releaseSecond();
  await second;
  const secondSettled = facts.find(
    (fact) =>
      fact.source === "runtime" &&
      fact.event === "settled" &&
      fact.ordinal === 2,
  );
  expect(secondSettled).toMatchObject({ phase: "unknown" });
});

test("a new fixture host preserves facts and advances the ordinal", async () => {
  const home = newHome(),
    writer = (path: string, content: string) => writeFileSync(path, content),
    firstHost = createCodexChatPrepareDiagnostics(
      createFilePrepareDiagnosticIo(home, writer),
    );
  await firstHost.observe("check", async () => undefined);
  const factsPath = join(home, CODEX_CHAT_PREPARE_FACTS_FILE),
    original = readFileSync(factsPath, "utf8"),
    nextOrdinal = initializePrepareDiagnosticFiles(home, writer);
  expect(readFileSync(factsPath, "utf8")).toBe(original);
  expect(nextOrdinal).toBe(1);

  const secondHost = createCodexChatPrepareDiagnostics(
    createFilePrepareDiagnosticIo(home, writer, nextOrdinal),
  );
  await secondHost.observe("prepare", async () => undefined);
  const rows = readFileSync(factsPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(
    rows
      .filter((row) => row.source === "runtime" && row.event === "started")
      .map((row) => row.ordinal),
  ).toEqual([1, 2]);
});

test("probe facts retain only an exact active operation ordinal", async () => {
  const home = newHome(),
    io = createFilePrepareDiagnosticIo(home, (path, content) =>
      writeFileSync(path, content),
    ),
    diagnostics = createCodexChatPrepareDiagnostics(io),
    original = new Error("private probe failure");
  await expect(
    diagnostics.observe("prepare", async () => {
      recordProbeFact(home, "version", "started");
      recordProbeFact(home, "version", "completed", 7);
      throw original;
    }),
  ).rejects.toBe(original);
  const rows = readFileSync(join(home, CODEX_CHAT_PREPARE_FACTS_FILE), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>),
    probeRows = rows.filter((row) => row.source === "probe");
  expect(probeRows).toHaveLength(2);
  expect(probeRows).toEqual([
    expect.objectContaining({
      correlation: "single",
      ordinal: 1,
      probe: "version",
      event: "started",
    }),
    expect.objectContaining({
      correlation: "single",
      ordinal: 1,
      probe: "version",
      event: "completed",
      elapsedMs: 7,
    }),
  ]);
  const summary = rows.find(
    (row) => row.source === "runtime" && row.event === "settled",
  );
  expect(summary).toMatchObject({
    phase: "between-probes",
    outcome: "failure",
    errorClass: "other",
  });
  expect(JSON.stringify(rows)).not.toContain("private probe failure");
});

test("diagnostic saturation and append bounds do not grow the history", async () => {
  const home = newHome(),
    io = createFilePrepareDiagnosticIo(home, (path, content) =>
      writeFileSync(path, content),
    ),
    diagnostics = createCodexChatPrepareDiagnostics(io);
  for (let i = 0; i < 40; i++)
    await diagnostics.observe("check", async () => i);
  expect(diagnostics.activeMarker()).toMatchObject({ state: "capped" });
  for (let i = 0; i < 1000; i++) recordProbeFact(home, "version", "started");
  const factsPath = join(home, CODEX_CHAT_PREPARE_FACTS_FILE),
    facts = readFileSync(factsPath, "utf8");
  expect(Buffer.byteLength(facts, "utf8")).toBeLessThanOrEqual(
    CODEX_CHAT_PREPARE_FACTS_MAX_BYTES,
  );
  expect(facts.split("\n").filter(Boolean).length).toBeLessThanOrEqual(
    CODEX_CHAT_PREPARE_FACTS_MAX_ROWS,
  );

  const boundedHome = newHome();
  writeFileSync(
    join(boundedHome, CODEX_CHAT_PREPARE_MARKER_FILE),
    JSON.stringify({
      version: 1,
      state: "single",
      ordinal: 1,
      operation: "prepare",
    }),
  );
  for (let i = 0; i < 1000; i++)
    recordProbeFact(boundedHome, "version", "started");
  const boundedFacts = readFileSync(
    join(boundedHome, CODEX_CHAT_PREPARE_FACTS_FILE),
    "utf8",
  );
  expect(Buffer.byteLength(boundedFacts, "utf8")).toBeLessThanOrEqual(
    CODEX_CHAT_PREPARE_FACTS_MAX_BYTES,
  );
  expect(boundedFacts.split("\n").filter(Boolean).length).toBeLessThanOrEqual(
    CODEX_CHAT_PREPARE_FACTS_MAX_ROWS,
  );
});

test("diagnostic writer failures preserve the exact result and thrown value", async () => {
  const original = new Error("sentinel"),
    io: PrepareDiagnosticIo = {
      now() {
        throw original;
      },
      writeMarker() {
        throw original;
      },
      appendFact() {
        throw original;
      },
      readFacts() {
        throw original;
      },
    },
    diagnostics = createCodexChatPrepareDiagnostics(io),
    returned = { exact: true };
  expect(await diagnostics.observe("check", async () => returned)).toBe(
    returned,
  );
  await expect(
    diagnostics.observe("prepare", async () => {
      throw original;
    }),
  ).rejects.toBe(original);
});

test("hostile thrown values and diagnostic append contention stay best effort", async () => {
  const facts: PrepareFact[] = [],
    marker = new Error("hostile inspection"),
    hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw marker;
        },
      },
    ),
    diagnostics = createCodexChatPrepareDiagnostics({
      now: () => 1,
      writeMarker() {},
      appendFact: (fact) => facts.push(fact),
      readFacts: () => ({ state: "available", facts }),
    });
  let caught: unknown;
  try {
    await diagnostics.observe("prepare", async () => {
      throw hostile;
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(hostile);
  expect(
    facts.find((fact) => fact.source === "runtime" && fact.event === "settled"),
  ).toMatchObject({ errorClass: "other" });

  const home = newHome(),
    io = createFilePrepareDiagnosticIo(home, (path, content) =>
      writeFileSync(path, content),
    ),
    factsPath = join(home, CODEX_CHAT_PREPARE_FACTS_FILE),
    before = readFileSync(factsPath, "utf8"),
    lockPath = `${factsPath}.lock`;
  mkdirSync(lockPath);
  io.appendFact({
    version: 1,
    source: "runtime",
    event: "saturated",
  });
  expect(readFileSync(factsPath, "utf8")).toBe(before);
  rmSync(lockPath, { recursive: true, force: true });
});
