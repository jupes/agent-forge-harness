import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { writeOwnerOnly } from "../hearth/token";
import { scratchDirs } from "../test-scratch";
import {
  ENVIRONMENT_LIMITS,
  type EnvironmentStatus,
} from "./environment-protocol";
import { createEnvironmentSettingsService } from "./environment-service";
import { withConfigTransaction } from "./transaction";

const scratch = scratchDirs();
const services: ReturnType<typeof createEnvironmentSettingsService>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  scratch.cleanup();
});
function fixture(
  controls: Partial<
    Pick<
      Parameters<typeof createEnvironmentSettingsService>[0],
      "write" | "withTransaction"
    >
  > = {},
) {
  const root = scratch.make("environment-settings"),
    checkout = join(root, "checkout"),
    osHome = join(root, "os-home"),
    coordinationRoot = join(root, "coordination");
  mkdirSync(checkout);
  mkdirSync(osHome);
  const service = createEnvironmentSettingsService({
    options: { harnessRoot: checkout, home: osHome, env: {} },
    coordinationRoot,
    ...controls,
  });
  services.push(service);
  return { root, checkout, osHome, coordinationRoot, service };
}
const requestFor = (status: EnvironmentStatus, names: string[]) => ({
  requestId: randomUUID(),
  ownerKey: status.ownerKey,
  expectedRevision: status.revision,
  expectedJournalRevision: status.record.revision,
  names,
});
test("read is inert; an exact reviewed save publishes only names and a matching durable receipt", async () => {
  const f = fixture(),
    before = f.service.read();
  expect(before.names).toEqual([]);
  expect(before.target).toBe("user");
  expect(existsSync(f.coordinationRoot)).toBe(false);
  expect(existsSync(join(f.osHome, ".agent-forge"))).toBe(false);
  const request = {
    requestId: randomUUID(),
    ownerKey: before.ownerKey,
    expectedRevision: before.revision,
    expectedJournalRevision: before.record.revision,
    names: ["TEAM_TOKEN"],
  };
  const saved = await f.service.save(request);
  expect(saved.record.last).toMatchObject({ request, state: "completed" });
  expect(saved.names).toEqual(["TEAM_TOKEN"]);
  expect(readFileSync(before.file, "utf8")).toContain('pass = ["TEAM_TOKEN"]');
  expect(existsSync(join(f.checkout, "agent-forge.toml"))).toBe(false);
  expect(f.service.read().record).toEqual(saved.record);
});

test("appearance or disappearance of the workspace layer refuses before intent or publication", async () => {
  for (const disappear of [false, true]) {
    let change = () => {};
    const f = fixture({
      withTransaction: async (context, work, options) => {
        change();
        return withConfigTransaction(context, work, options);
      },
    });
    const workspace = join(f.checkout, "agent-forge.toml");
    if (disappear) writeFileSync(workspace, "# existing workspace\n");
    const before = f.service.read();
    change = () =>
      disappear
        ? unlinkSync(workspace)
        : writeFileSync(workspace, "# appeared\n");
    await expect(
      f.service.save(requestFor(before, ["TEAM_TOKEN"])),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      existsSync(join(f.coordinationRoot, "environment-v1", "initialized")),
    ).toBe(false);
    expect(existsSync(join(f.osHome, ".agent-forge", "config.toml"))).toBe(
      false,
    );
    if (!disappear)
      expect(readFileSync(workspace, "utf8")).toBe("# appeared\n");
  }
});

test("published config without terminal receipt remains pending across roots and profiles even when names match", async () => {
  const f = fixture({
    withTransaction: (context, work, options) =>
      withConfigTransaction(
        context,
        (transaction) =>
          work({
            ...transaction,
            publish(bytes) {
              transaction.publish(bytes);
              throw Error("private injected failure");
            },
          }),
        options,
      ),
  });
  const before = f.service.read(),
    request = requestFor(before, ["TEAM_TOKEN"]);
  await expect(f.service.save(request)).rejects.toMatchObject({ status: 504 });
  expect(f.service.read()).toMatchObject({
    names: ["TEAM_TOKEN"],
    canSave: false,
    record: { last: { state: "pending", request } },
  });
  const otherRoot = join(f.root, "other-checkout"),
    otherHome = join(f.root, "other-home");
  mkdirSync(otherRoot);
  mkdirSync(otherHome);
  const other = createEnvironmentSettingsService({
    options: { harnessRoot: otherRoot, home: otherHome, env: {} },
    coordinationRoot: f.coordinationRoot,
  });
  services.push(other);
  const observed = other.read();
  expect(observed.ownerKey).not.toBe(before.ownerKey);
  expect(observed.canSave).toBe(false);
  await expect(
    other.save(requestFor(observed, ["OTHER"])),
  ).rejects.toMatchObject({ status: 504 });
  expect(existsSync(join(otherHome, ".agent-forge", "config.toml"))).toBe(
    false,
  );
});

test("maximum allowed names fit request, durable receipt and bounded status without truncation", async () => {
  const f = fixture(),
    before = f.service.read(),
    names = Array.from(
      { length: 256 },
      (_, index) => `N${String(index).padStart(3, "0")}${"x".repeat(124)}`,
    ),
    request = requestFor(before, names);
  expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(
    ENVIRONMENT_LIMITS.requestBytes,
  );
  const saved = await f.service.save(request);
  expect(saved.names).toEqual(names);
  expect(saved.record.last?.request).toEqual(request);
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThanOrEqual(
    ENVIRONMENT_LIMITS.responseBytes,
  );
  expect(Buffer.byteLength(JSON.stringify(saved.record))).toBeLessThanOrEqual(
    ENVIRONMENT_LIMITS.recordBytes,
  );
});

test("public failure messages never expose raw TOML values", async () => {
  const f = fixture();
  writeFileSync(
    join(f.checkout, "agent-forge.toml"),
    '[smiths.private]\nprovider = "PRIVATE_CONFIG_VALUE"\n',
  );
  try {
    f.service.read();
    throw Error("Expected unavailable config");
  } catch (error) {
    expect(error).toMatchObject({ status: 503 });
    expect((error as Error).message).not.toContain("PRIVATE_CONFIG_VALUE");
    expect((error as Error).message).not.toContain("smiths");
  }
});

test("close joins queued work and refuses publication after the queue is released", async () => {
  let entered = () => {},
    release = () => {};
  const started = new Promise<void>((done) => {
      entered = done;
    }),
    barrier = new Promise<void>((done) => {
      release = done;
    });
  const f = fixture({
      withTransaction: async (context, work, options) => {
        entered();
        await barrier;
        return withConfigTransaction(context, work, options);
      },
    }),
    before = f.service.read();
  const saving = f.service.save(requestFor(before, ["TEAM_TOKEN"]));
  const outcome = saving.catch((error: unknown) => error);
  await started;
  let joined = false;
  const closing = f.service.close().then(() => {
    joined = true;
  });
  try {
    await Promise.resolve();
    expect(joined).toBe(false);
  } finally {
    release();
  }
  expect(await outcome).toMatchObject({ status: 503 });
  await closing;
  expect(joined).toBe(true);
  expect(existsSync(before.file)).toBe(false);
  expect(existsSync(join(f.coordinationRoot, "environment-v1"))).toBe(false);
});

test("a completed receipt published before an error is recoverable after recreation without another config publication", async () => {
  let publications = 0;
  const f = fixture({
    withTransaction: (context, work, options) =>
      withConfigTransaction(
        context,
        (transaction) =>
          work({
            ...transaction,
            publish(bytes) {
              publications++;
              return transaction.publish(bytes);
            },
          }),
        options,
      ),
    write(file, text) {
      writeOwnerOnly(file, text);
      if (file.endsWith("latest.json") && text.includes('"state":"completed"'))
        throw Error("reply lost after durable completion");
    },
  });
  const request = requestFor(f.service.read(), ["TEAM_TOKEN"]);
  await expect(f.service.save(request)).rejects.toMatchObject({ status: 504 });
  const held = f.service.read();
  expect(held).toMatchObject({
    names: ["TEAM_TOKEN"],
    canSave: false,
    record: { last: { request, state: "completed" } },
  });
  await expect(
    f.service.save(requestFor(held, ["OTHER"])),
  ).rejects.toMatchObject({ status: 504 });
  await f.service.close();
  const recreated = createEnvironmentSettingsService({
    options: { harnessRoot: f.checkout, home: f.osHome, env: {} },
    coordinationRoot: f.coordinationRoot,
  });
  services.push(recreated);
  expect(recreated.read()).toMatchObject({
    names: ["TEAM_TOKEN"],
    record: { last: { request, state: "completed" } },
  });
  expect(publications).toBe(1);
});
