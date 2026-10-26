import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { scratchDirs } from "../test-scratch";
import {
  prepareConfigTransaction,
  readConfigTransactionSources,
  withConfigTransaction,
} from "./transaction";
import {
  type ConfigDescriptorReadIo,
  readConfigDescriptor,
} from "./transaction-read";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

function box(maxSourceBytes = 32) {
  const root = scratch.make("config-bounded-read-"),
    workspace = join(root, "workspace");
  mkdirSync(workspace);
  const input = {
    options: { harnessRoot: workspace, home: join(root, "user"), env: {} },
    target: "workspace" as const,
    coordinationRoot: join(root, "coordination"),
    maxSourceBytes,
  };
  const context = prepareConfigTransaction(input);
  return { input, context };
}

test("an oversized optimistic source refuses before creating config or coordination metadata", () => {
  const { context, input } = box();
  const before = "#".repeat(input.maxSourceBytes + 1);
  writeFileSync(context.files.workspace, before);
  expect(() => readConfigTransactionSources(context)).toThrow("byte limit");
  expect(readFileSync(context.files.workspace, "utf8")).toBe(before);
  expect(existsSync(input.coordinationRoot)).toBe(false);
  expect(existsSync(input.options.home)).toBe(false);
});

test("a descriptor already over its bound allocates and reads no source bytes", () => {
  let allocations = 0,
    reads = 0;
  const io: ConfigDescriptorReadIo = {
    allocate: () => {
      allocations++;
      throw Error("Unexpected allocation");
    },
    read: () => {
      reads++;
      throw Error("Unexpected read");
    },
    readAll: () => {
      reads++;
      throw Error("Unexpected unbounded read");
    },
  };
  expect(() => readConfigDescriptor(123, 5n, 4, io)).toThrow("byte limit");
  expect(allocations).toBe(0);
  expect(reads).toBe(0);
});

test("actual growth after descriptor stat reads at most limit plus one on that same descriptor", () => {
  const root = scratch.make("config-growing-descriptor-"),
    file = join(root, "source.toml");
  writeFileSync(file, "1234");
  const fd = openSync(file, "r"),
    size = fstatSync(fd, { bigint: true }).size,
    allocations: number[] = [],
    descriptors: number[] = [];
  let readBytes = 0,
    unbounded = false;
  try {
    const io: ConfigDescriptorReadIo = {
      allocate: (length) => {
        allocations.push(length);
        return Buffer.alloc(length);
      },
      read: (actualFd, bytes, offset, length) => {
        descriptors.push(actualFd);
        if (descriptors.length === 1) appendFileSync(file, "5678901234567890");
        const count = readSync(actualFd, bytes, offset, length, null);
        readBytes += count;
        return count;
      },
      readAll: () => {
        unbounded = true;
        throw Error("Unexpected unbounded read");
      },
    };
    expect(() => readConfigDescriptor(fd, size, 4, io)).toThrow("byte limit");
    expect(allocations).toEqual([5]);
    expect(descriptors).toEqual([fd]);
    expect(readBytes).toBe(5);
    expect(unbounded).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("12345678901234567890");
  } finally {
    closeSync(fd);
  }
});

test("short descriptor reads share one bounded allocation and require the statted byte count", () => {
  const content = Buffer.from("1234"),
    allocations: number[] = [],
    descriptors: number[] = [];
  let position = 0;
  const io: ConfigDescriptorReadIo = {
    allocate: (length) => {
      allocations.push(length);
      return Buffer.alloc(length);
    },
    read: (fd, bytes, offset) => {
      descriptors.push(fd);
      if (position === content.length) return 0;
      bytes[offset] = content[position++] ?? 0;
      return 1;
    },
    readAll: () => {
      throw Error("Unexpected unbounded read");
    },
  };
  expect(readConfigDescriptor(456, 4n, 8, io).toString()).toBe("1234");
  expect(allocations).toEqual([9]);
  expect(descriptors).toEqual([456, 456, 456, 456, 456]);
  expect(position).toBe(4);
  position = 0;
  expect(() => readConfigDescriptor(456, 5n, 8, io)).toThrow("changed");
});

test("undefined retains the original unbounded descriptor reader and result", () => {
  const legacy = Buffer.from("legacy"),
    seen: number[] = [];
  const io: ConfigDescriptorReadIo = {
    allocate: () => {
      throw Error("Legacy read must not allocate a bounded buffer");
    },
    read: () => {
      throw Error("Legacy read must not change descriptor semantics");
    },
    readAll: (fd) => {
      seen.push(fd);
      return legacy;
    },
  };
  expect(readConfigDescriptor(789, 99_999n, undefined, io)).toBe(legacy);
  expect(seen).toEqual([789]);
});

test("prepared trusted bounds are captured and reject invalid limits without creating metadata", () => {
  const { context, input } = box(4);
  input.maxSourceBytes = 100;
  writeFileSync(context.files.workspace, "12345");
  expect(() => readConfigTransactionSources(context)).toThrow("byte limit");
  for (const maxSourceBytes of [0, -1, 1.5, Infinity, NaN])
    expect(() =>
      prepareConfigTransaction({ ...input, maxSourceBytes }),
    ).toThrow("byte limit");
  expect(existsSync(input.coordinationRoot)).toBe(false);
});

test.each([
  "user",
  "workspace",
] as const)("held admission bounds the %s source before its callback", async (source) => {
  const { context, input } = box(),
    file = context.files[source],
    before = "#".repeat(33);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, before);
  let entered = false;
  await expect(
    withConfigTransaction(context, () => {
      entered = true;
    }),
  ).rejects.toMatchObject({ reason: "invalid", replacementAttempted: false });
  expect(entered).toBe(false);
  expect(readFileSync(file, "utf8")).toBe(before);
  if (source === "user")
    expect(existsSync(context.files.workspace)).toBe(false);
  expect(existsSync(context.lockFile)).toBe(true);
  expect(dirname(context.lockFile)).toBe(
    realpathSync.native(input.coordinationRoot),
  );
});

test.each([
  "user",
  "workspace",
] as const)("pre-publication recheck bounds a newly oversized %s source", async (source) => {
  const { context } = box(),
    file = context.files[source],
    external = "#".repeat(33);
  await expect(
    withConfigTransaction(context, (tx) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, external);
      tx.publish(Buffer.from("# must not publish\n"));
    }),
  ).rejects.toMatchObject({ reason: "invalid", replacementAttempted: false });
  expect(readFileSync(file, "utf8")).toBe(external);
  if (source === "user")
    expect(existsSync(context.files.workspace)).toBe(false);
});

test("post-rename readback is bounded and an oversized result remains attempted and unconfirmed", async () => {
  const { context } = box(),
    candidate = Buffer.from("#".repeat(33));
  await expect(
    withConfigTransaction(context, (tx) => tx.publish(candidate)),
  ).rejects.toMatchObject({
    reason: "unconfirmed",
    replacementAttempted: true,
  });
  expect(readFileSync(context.files.workspace)).toEqual(candidate);
  expect(readdirSync(dirname(context.files.workspace))).toEqual([
    "agent-forge.toml",
  ]);
  expect(existsSync(context.files.user)).toBe(false);
});

test("exact-bound reads and repeated publication snapshots retain unchanged source-copy behavior", async () => {
  const { context } = box(4);
  writeFileSync(context.files.workspace, "1234");
  const optimistic = readConfigTransactionSources(context);
  expect(Buffer.from(optimistic.sources.workspace.bytes ?? []).toString()).toBe(
    "1234",
  );
  optimistic.sources.workspace.bytes?.fill(0);
  const published = await withConfigTransaction(context, (tx) => {
    expect(Buffer.from(tx.sources.workspace.bytes ?? []).toString()).toBe(
      "1234",
    );
    return tx.publish(Buffer.from("5678"));
  });
  expect(published.created).toBe(false);
  expect(readFileSync(context.files.workspace, "utf8")).toBe("5678");
});

test("an omitted policy still reads and publishes larger scalar sources", async () => {
  const { input } = box(4),
    context = prepareConfigTransaction({
      options: input.options,
      target: input.target,
      coordinationRoot: input.coordinationRoot,
    });
  writeFileSync(context.files.workspace, "#".repeat(33));
  expect(
    readConfigTransactionSources(context).sources.workspace.bytes?.length,
  ).toBe(33);
  await withConfigTransaction(context, (tx) =>
    tx.publish(Buffer.from("#".repeat(65))),
  );
  expect(readFileSync(context.files.workspace, "utf8")).toBe("#".repeat(65));
});
