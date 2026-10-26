import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  SmithRoutingEditChange,
  SmithRoutingEditRequest,
} from "../../types/smith-routing-edit";
import { scratchDirs } from "../test-scratch";
import { machineConfigFile } from "./load";
import { createSmithRoutingEditService } from "./smith-routing-edit-service";
import type {
  ConfigWriteTransaction,
  PreparedConfigTransaction,
} from "./transaction";
import { withConfigTransaction } from "./transaction";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

const initial =
  '\uFEFF# keep this comment\r\n[workflow]\r\ndefault_crew = "claude-master" # keep workflow comment\r\n\r\n[benches]\r\nlow = ["claude-master:1"] # keep low comment\r\nmedium = ["claude-apprentice:1"] # unrelated\r\n';
const expected =
  '\uFEFF# keep this comment\r\n[workflow]\r\ndefault_crew = "claude-master" # keep workflow comment\r\n\r\n[benches]\r\nlow = ["claude-master:0.5", "claude-master:0.75"] # keep low comment\r\nmedium = ["claude-apprentice:1"] # unrelated\r\n';
const change: SmithRoutingEditChange = {
  kind: "bench",
  bench: "low",
  entries: [
    { smith: "claude-master", weight: 0.5 },
    { smith: "claude-master", weight: 0.75 },
  ],
};

function fixture() {
  const base = scratch.make("smith-routing-edit-"),
    checkout = join(base, "checkout"),
    profile = join(base, "profile"),
    home = join(base, "home"),
    coordinationRoot = join(base, "coordination");
  for (const path of [checkout, profile, home]) mkdirSync(path);
  const workspaceFile = join(checkout, "agent-forge.toml"),
    userFile = machineConfigFile({ home });
  writeFileSync(workspaceFile, initial);
  const loadOptions = { harnessRoot: checkout, home, env: {} };
  const service = (
    controls: Parameters<typeof createSmithRoutingEditService>[1] = {},
  ) =>
    createSmithRoutingEditService(
      { options: loadOptions },
      { profileHome: profile, coordinationRoot, ...controls },
    );
  return {
    base,
    checkout,
    profile,
    home,
    coordinationRoot,
    workspaceFile,
    userFile,
    service,
  };
}

async function reviewedRequest(
  service: ReturnType<ReturnType<typeof fixture>["service"]>,
  selected: SmithRoutingEditChange = change,
): Promise<SmithRoutingEditRequest> {
  const preview = service.preview({ target: "workspace", change: selected });
  return {
    requestId: randomUUID().toLowerCase(),
    target: "workspace",
    change: selected,
    expectedRevision: preview.expectedRevision,
  };
}

test("preview changes neither config nor the routing journal or shared lock", () => {
  const f = fixture(),
    before = readFileSync(f.workspaceFile),
    service = f.service();
  const preview = service.preview({ target: "workspace", change });

  expect(preview.review.effectiveAfter).toEqual(change.entries);
  expect(readFileSync(f.workspaceFile)).toEqual(before);
  expect(existsSync(f.userFile)).toBe(false);
  expect(existsSync(dirname(f.userFile))).toBe(false);
  expect(existsSync(join(f.profile, "smith-routing-edit-journal"))).toBe(false);
  expect(existsSync(f.coordinationRoot)).toBe(false);
});

test("one real routing publication preserves BOM, CRLF, comments and unrelated values", async () => {
  const f = fixture(),
    service = f.service(),
    request = await reviewedRequest(service),
    receipt = await service.edit(request);

  expect(receipt.result.phase).toBe("confirmed");
  expect(readFileSync(f.workspaceFile, "utf8")).toBe(expected);
  expect(readFileSync(f.workspaceFile)[0]).toBe(0xef);
});

test("recreated exact duplicate returns its history without reading or publishing current config", async () => {
  const f = fixture(),
    firstService = f.service(),
    request = await reviewedRequest(firstService),
    first = await firstService.edit(request);
  writeFileSync(
    f.workspaceFile,
    '[workflow]\ndefault_crew = "claude-apprentice"\n[benches]\nlow = ["claude-apprentice:1"]\n',
  );
  let transactionCalls = 0;
  const recreated = f.service({
    withTransaction: async <T>(
      _context: PreparedConfigTransaction,
      _work: (transaction: ConfigWriteTransaction) => T | Promise<T>,
    ): Promise<T> => {
      transactionCalls++;
      throw new Error("exact duplicate must not transact");
    },
  });

  expect(recreated.readOriginal(request.requestId)).toEqual(first);
  expect(await recreated.edit(request)).toEqual(first);
  expect(transactionCalls).toBe(0);
  expect(readFileSync(f.workspaceFile, "utf8")).toContain(
    'default_crew = "claude-apprentice"',
  );
});

test("a stale paired revision has a durable refusal and a separately reviewed UUID can proceed", async () => {
  const f = fixture(),
    service = f.service(),
    request = await reviewedRequest(service);
  mkdirSync(dirname(f.userFile), { recursive: true });
  writeFileSync(f.userFile, "# changed after paired review\n");

  const refusal = await service.edit(request);
  expect(refusal.result).toMatchObject({
    phase: "refused",
    reason: "stale-revision",
  });
  expect(service.readOriginal(request.requestId)).toEqual(refusal);

  const fresh = await reviewedRequest(service),
    confirmed = await service.edit(fresh);
  expect(fresh.requestId).not.toBe(request.requestId);
  expect(confirmed.result.phase).toBe("confirmed");
});

test("uncertain real publication stays held and exact duplicate never reapplies it", async () => {
  const f = fixture();
  let transactionCalls = 0;
  const failAfterRename: NonNullable<
    Parameters<typeof createSmithRoutingEditService>[1]
  >["withTransaction"] = async <T>(
    context: PreparedConfigTransaction,
    work: (transaction: ConfigWriteTransaction) => T | Promise<T>,
  ): Promise<T> => {
    transactionCalls++;
    return withConfigTransaction(context, (transaction) =>
      work({
        sources: transaction.sources,
        revision: transaction.revision,
        publish(bytes) {
          transaction.publish(bytes);
          throw new Error("injected lost publication response after rename");
        },
      }),
    );
  };
  const service = f.service({ withTransaction: failAfterRename }),
    request = await reviewedRequest(service),
    receipt = await service.edit(request);

  expect(receipt.result).toMatchObject({ phase: "held", stage: "unconfirmed" });
  if (receipt.result.phase !== "held" || receipt.result.preview === null)
    throw new Error("held routing receipt lost its preview");
  const published = readFileSync(f.workspaceFile);
  expect(createHash("sha256").update(published).digest("hex")).toBe(
    receipt.result.preview.candidate.sha256,
  );
  expect(published.toString("utf8")).toBe(expected);

  expect(await service.edit(request)).toEqual(receipt);
  expect(transactionCalls).toBe(1);
  expect(readFileSync(f.workspaceFile)).toEqual(published);
});

test("concurrent services from one paired revision permit one publish and refuse the stale contender", async () => {
  const f = fixture(),
    first = f.service(),
    second = f.service(),
    firstChange: SmithRoutingEditChange = {
      kind: "bench",
      bench: "low",
      entries: [{ smith: "claude-master", weight: 0.25 }],
    },
    secondChange: SmithRoutingEditChange = {
      kind: "bench",
      bench: "low",
      entries: [{ smith: "claude-master", weight: 0.75 }],
    },
    firstRequest = await reviewedRequest(first, firstChange),
    secondRequest = await reviewedRequest(second, secondChange);
  expect(firstRequest.expectedRevision).toEqual(secondRequest.expectedRevision);

  const results = await Promise.all([
      first.edit(firstRequest),
      second.edit(secondRequest),
    ]),
    confirmed = results.filter(
      (receipt) => receipt.result.phase === "confirmed",
    ),
    refused = results.filter((receipt) => receipt.result.phase === "refused");
  expect(confirmed).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect(refused[0]!.result).toMatchObject({
    phase: "refused",
    reason: "stale-revision",
  });
});
