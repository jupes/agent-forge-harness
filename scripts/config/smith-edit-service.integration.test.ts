import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Smith } from "../../types/hearth";
import type { SmithConfigEditRequest } from "../../types/smith-config-edit";
import { scratchDirs } from "../test-scratch";
import { machineConfigFile } from "./load";
import { createSmithEditService } from "./smith-edit-service";
import type {
  ConfigWriteTransaction,
  PreparedConfigTransaction,
} from "./transaction";
import { withConfigTransaction } from "./transaction";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

const selectedSmith: Smith = {
  name: "claude-master",
  provider: "claude",
  model: "reviewed-model",
  effort: "high",
  enabled: false,
  tags: ["rank:master", "reviewed"],
};
const baseline =
  '\uFEFF# untouched\r\n[unknown]\r\nnumber = 41 # exact\r\n[smiths.claude-master]\r\nmodel = "old" # model note\r\neffort = "high"\r\nprovider = "claude"\r\nenabled = true\r\ntags = ["rank:master"] # tags note\r\n';
const expectedPublished =
  '\uFEFF# untouched\r\n[unknown]\r\nnumber = 41 # exact\r\n[smiths.claude-master]\r\nmodel = "reviewed-model" # model note\r\neffort = "high"\r\nprovider = "claude"\r\nenabled = false\r\ntags = ["rank:master", "reviewed"] # tags note\r\n';

function fixture(options: { userText?: string; workspaceText?: string } = {}) {
  const base = scratch.make("smith-edit-transaction-"),
    checkout = join(base, "checkout"),
    profile = join(base, "profile"),
    home = join(base, "home"),
    coordinationRoot = join(base, "coordination");
  for (const path of [checkout, profile, home]) mkdirSync(path);
  const workspaceFile = join(checkout, "agent-forge.toml"),
    userFile = machineConfigFile({ home });
  writeFileSync(workspaceFile, options.workspaceText ?? baseline);
  if (options.userText !== undefined) {
    mkdirSync(dirname(userFile), { recursive: true });
    writeFileSync(userFile, options.userText);
  }
  const loadOptions = { harnessRoot: checkout, home, env: {} };
  const service = (
    controls: Parameters<typeof createSmithEditService>[1] = {},
  ) =>
    createSmithEditService(
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
  smith: Smith = selectedSmith,
): Promise<SmithConfigEditRequest> {
  const preview = service.preview({
    target: "workspace",
    name: smith.name,
    smith,
  });
  return {
    requestId: randomUUID().toLowerCase(),
    target: "workspace",
    name: smith.name,
    smith,
    expectedRevision: preview.expectedRevision,
  };
}

test("preview leaves configs, edit journal and global lock directory untouched", () => {
  const f = fixture(),
    before = readFileSync(f.workspaceFile),
    service = f.service();

  const preview = service.preview({
    target: "workspace",
    name: selectedSmith.name,
    smith: selectedSmith,
  });

  expect(preview.review.effectiveAfter).toEqual(selectedSmith);
  expect(readFileSync(f.workspaceFile)).toEqual(before);
  expect(existsSync(f.userFile)).toBe(false);
  expect(existsSync(dirname(f.userFile))).toBe(false);
  expect(existsSync(join(f.profile, "smith-edit-journal"))).toBe(false);
  expect(existsSync(f.coordinationRoot)).toBe(false);
});

test("real publication preserves BOM, CRLF, comments, order and the complete selected table", async () => {
  const f = fixture(),
    service = f.service(),
    request = await reviewedRequest(service),
    receipt = await service.edit(request),
    actual = readFileSync(f.workspaceFile);

  expect(receipt.result.phase).toBe("confirmed");
  expect(actual.toString("utf8")).toBe(expectedPublished);
  expect(actual[0]).toBe(0xef);
  expect(actual.toString("utf8").replaceAll("\r\n", "").includes("\n")).toBe(
    false,
  );
});

test("recreated duplicate returns the historical receipt after an external target edit without rewriting it", async () => {
  const f = fixture(),
    firstService = f.service(),
    request = await reviewedRequest(firstService),
    original = await firstService.edit(request);
  expect(original.result.phase).toBe("confirmed");

  const external = Buffer.from(
    '[smiths.claude-master]\nmodel = "external-change"\n',
  );
  writeFileSync(f.workspaceFile, external);
  let transactionCalls = 0;
  const recreated = f.service({
    withTransaction: async <T>(
      _context: PreparedConfigTransaction,
      _work: (transaction: ConfigWriteTransaction) => T | Promise<T>,
    ): Promise<T> => {
      transactionCalls++;
      throw new Error("an exact duplicate must not reread or transact");
    },
  });

  expect(recreated.readOriginal(request.requestId)).toEqual(original);
  expect(await recreated.edit(request)).toEqual(original);
  expect(transactionCalls).toBe(0);
  expect(readFileSync(f.workspaceFile)).toEqual(external);
});

test("change to the unselected user layer makes the paired revision stale before target publication", async () => {
  const userText = '[smiths.claude-master]\nmodel = "user-layer"\n',
    f = fixture({ userText }),
    service = f.service(),
    request = await reviewedRequest(service),
    targetBefore = readFileSync(f.workspaceFile);
  writeFileSync(f.userFile, `${userText}# changed after review\n`);

  const receipt = await service.edit(request);

  expect(receipt.result).toMatchObject({
    phase: "refused",
    reason: "stale-revision",
    preview: null,
  });
  expect(readFileSync(f.workspaceFile)).toEqual(targetBefore);
  expect(existsSync(f.coordinationRoot)).toBe(true);
  expect(receipt.result.phase === "refused" && receipt.result.preview).toBe(
    null,
  );
});

test("failure after a real rename is held and duplicate cannot reapply the edit", async () => {
  const f = fixture();
  let transactionCalls = 0;
  const failAfterRename: NonNullable<
    Parameters<typeof createSmithEditService>[1]
  >["withTransaction"] = async <T>(
    context: PreparedConfigTransaction,
    work: (transaction: ConfigWriteTransaction) => T | Promise<T>,
  ): Promise<T> => {
    transactionCalls++;
    return withConfigTransaction(context, (transaction) => {
      const uncertain: ConfigWriteTransaction = {
        sources: transaction.sources,
        revision: transaction.revision,
        publish(bytes) {
          transaction.publish(bytes);
          throw new Error("injected lost publication response after rename");
        },
      };
      return work(uncertain);
    });
  };
  const service = f.service({ withTransaction: failAfterRename }),
    request = await reviewedRequest(service),
    receipt = await service.edit(request);

  expect(receipt.result).toMatchObject({ phase: "held", stage: "attempted" });
  if (receipt.result.phase !== "held" || receipt.result.preview === null)
    throw new Error("the held receipt lost its reviewed candidate");
  const published = readFileSync(f.workspaceFile);
  expect(createHash("sha256").update(published).digest("hex")).toBe(
    receipt.result.preview.candidate.sha256,
  );
  expect(published.toString("utf8")).toBe(expectedPublished);

  expect(await service.edit(request)).toEqual(receipt);
  expect(transactionCalls).toBe(1);
  expect(readFileSync(f.workspaceFile)).toEqual(published);
});

test("concurrent edits from the same paired revision permit one publication and refuse the stale contender", async () => {
  const f = fixture(),
    first = f.service(),
    second = f.service(),
    firstSmith = { ...selectedSmith, model: "first-writer" },
    secondSmith = { ...selectedSmith, model: "second-writer" },
    firstRequest = await reviewedRequest(first, firstSmith),
    secondRequest = await reviewedRequest(second, secondSmith);
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
  const finalText = readFileSync(f.workspaceFile, "utf8");
  expect(
    finalText.includes('model = "first-writer"') ||
      finalText.includes('model = "second-writer"'),
  ).toBe(true);
});
