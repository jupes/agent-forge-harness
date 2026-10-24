import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { scratchDirs } from "../test-scratch";
import {
  ConfigTransactionError,
  type ConfigWriteTransaction,
  prepareConfigTransaction,
  readConfigTransactionSources,
  withConfigTransaction,
} from "./transaction";

const scratch = scratchDirs();
afterEach(() => scratch.cleanup());

function box() {
  const root = scratch.make("config-transaction-");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const options = {
    harnessRoot: workspace,
    home: join(root, "absent-user"),
    env: {},
  };
  const coordinationRoot = join(root, "coordination");
  return {
    root,
    options,
    coordinationRoot,
    prepare: (target: "user" | "workspace" = "workspace") =>
      prepareConfigTransaction({ options, target, coordinationRoot }),
  };
}

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}

test("prepared read-only context is frozen, default mutex ignores config homes/profiles, and preview creates nothing", () => {
  const b = box();
  const first = prepareConfigTransaction({
    options: b.options,
    target: "workspace",
  });
  const second = prepareConfigTransaction({
    options: {
      ...b.options,
      home: join(b.root, "different-user-layer"),
      harnessRoot: b.root,
    },
    target: "user",
  });
  expect(first.lockFile).toBe(second.lockFile);
  const context = b.prepare();
  expect(Object.isFrozen(context)).toBe(true);
  expect(Object.isFrozen(context.files)).toBe(true);
  expect(Object.isFrozen(context.env)).toBe(true);
  expect(readConfigTransactionSources(context).sources.user.bytes).toBeNull();
  expect(
    readConfigTransactionSources(context).sources.workspace.bytes,
  ).toBeNull();
  expect(existsSync(b.coordinationRoot)).toBe(false);
  expect(existsSync(b.options.home)).toBe(false);
  expect(existsSync(context.files.workspace)).toBe(false);
});

test("publication creates only selected parents and copied snapshots never alias private source bytes", async () => {
  const b = box();
  const context = b.prepare();
  await withConfigTransaction(context, (tx) =>
    tx.publish(Buffer.from("# first\n")),
  );
  const result = await withConfigTransaction(context, (tx) => {
    tx.sources.workspace.bytes?.fill(0);
    expect(Buffer.from(tx.sources.workspace.bytes ?? []).toString()).toBe(
      "# first\n",
    );
    return tx.publish(Buffer.from("# second\n"));
  });
  expect(result.created).toBe(false);
  expect(readFileSync(context.files.workspace, "utf8")).toBe("# second\n");
  expect(existsSync(b.options.home)).toBe(false);
  const user = b.prepare("user");
  await withConfigTransaction(user, (tx) =>
    tx.publish(Buffer.from("# user\n")),
  );
  expect(readFileSync(user.files.user, "utf8")).toBe("# user\n");
});

test("two independent contexts cannot enter work together and second reads the first publication", async () => {
  const b = box();
  const entered = deferred();
  const release = deferred();
  const first = withConfigTransaction(b.prepare(), async (tx) => {
    entered.release();
    await release.promise;
    tx.publish(Buffer.from("# first\n"));
  });
  await entered.promise;
  let secondEntered = false;
  const second = withConfigTransaction(b.prepare(), (tx) => {
    secondEntered = true;
    expect(Buffer.from(tx.sources.workspace.bytes ?? []).toString()).toBe(
      "# first\n",
    );
    tx.publish(Buffer.from("# first\n# second\n"));
  });
  let statuses: string[] = [];
  try {
    expect(secondEntered).toBe(false);
  } finally {
    release.release();
    const settled = await Promise.allSettled([first, second]);
    statuses = settled.map((item) => item.status);
  }
  expect(statuses).toEqual(["fulfilled", "fulfilled"]);
  expect(readFileSync(b.prepare().files.workspace, "utf8")).toBe(
    "# first\n# second\n",
  );
});

test("a changed paired layer or absent-to-created leaf refuses before selected publication", async () => {
  const b = box();
  const context = b.prepare();
  await expect(
    withConfigTransaction(context, (tx) => {
      mkdirSync(join(b.options.home, ".agent-forge"), { recursive: true });
      writeFileSync(context.files.user, "# external user\n");
      tx.publish(Buffer.from("# selected\n"));
    }),
  ).rejects.toMatchObject({ reason: "changed", replacementAttempted: false });
  expect(existsSync(context.files.workspace)).toBe(false);
  expect(readFileSync(context.files.user, "utf8")).toBe("# external user\n");
  const review = readConfigTransactionSources(context).revision;
  writeFileSync(context.files.workspace, "# externally created\n");
  let called = false;
  await expect(
    withConfigTransaction(
      context,
      () => {
        called = true;
      },
      { expectedRevision: review },
    ),
  ).rejects.toMatchObject({ reason: "changed" });
  expect(called).toBe(false);
  expect(readFileSync(context.files.workspace, "utf8")).toBe(
    "# externally created\n",
  );
});

test("same-byte leaf and parent replacement cannot retain the reviewed write identity", async () => {
  const b = box();
  const context = b.prepare();
  writeFileSync(context.files.workspace, "# unchanged bytes\n");
  await expect(
    withConfigTransaction(context, (tx) => {
      const replacement = join(b.root, "new-file");
      writeFileSync(replacement, "# unchanged bytes\n");
      renameSync(replacement, context.files.workspace);
      tx.publish(Buffer.from("# would overwrite\n"));
    }),
  ).rejects.toMatchObject({ reason: "changed", replacementAttempted: false });
  expect(readFileSync(context.files.workspace, "utf8")).toBe(
    "# unchanged bytes\n",
  );
  await expect(
    withConfigTransaction(context, (tx) => {
      renameSync(b.options.harnessRoot, `${b.options.harnessRoot}-moved`);
      mkdirSync(b.options.harnessRoot);
      writeFileSync(context.files.workspace, "# unchanged bytes\n");
      tx.publish(Buffer.from("# would overwrite\n"));
    }),
  ).rejects.toMatchObject({ reason: "changed", replacementAttempted: false });
  expect(readFileSync(context.files.workspace, "utf8")).toBe(
    "# unchanged bytes\n",
  );
});

test("multiply linked config leaves refuse without modifying either name", async () => {
  const b = box();
  const context = b.prepare();
  const other = join(b.root, "linked-file");
  writeFileSync(other, "# shared\n");
  linkSync(other, context.files.workspace);
  let called = false;
  await expect(
    withConfigTransaction(context, () => {
      called = true;
    }),
  ).rejects.toThrow("multiply linked");
  expect(called).toBe(false);
  expect(readFileSync(other, "utf8")).toBe("# shared\n");
  expect(readFileSync(context.files.workspace, "utf8")).toBe("# shared\n");
});

test("busy acquisition never enters work and the same persistent lock survives release", async () => {
  const b = box();
  const context = b.prepare();
  const entered = deferred();
  const release = deferred();
  const first = withConfigTransaction(context, async () => {
    entered.release();
    await release.promise;
  });
  await entered.promise;
  const lockBefore = lstatSync(context.lockFile, { bigint: true });
  let called = false;
  try {
    await expect(
      withConfigTransaction(
        context,
        () => {
          called = true;
        },
        { waitMs: 50 },
      ),
    ).rejects.toMatchObject({ reason: "busy", replacementAttempted: false });
    expect(called).toBe(false);
    expect(existsSync(context.files.workspace)).toBe(false);
  } finally {
    release.release();
    await first;
  }
  await withConfigTransaction(context, () => {});
  const lockAfter = lstatSync(context.lockFile, { bigint: true });
  expect([lockAfter.dev, lockAfter.ino]).toEqual([
    lockBefore.dev,
    lockBefore.ino,
  ]);
});

test("cancelled never-settling work releases ownership and its late publisher cannot write", async () => {
  const b = box();
  const context = b.prepare();
  const entered = deferred();
  const release = deferred();
  const controller = new AbortController();
  let late: Promise<void> = Promise.resolve();
  const pending = withConfigTransaction(
    context,
    (tx) => {
      late = release.promise.then(() => {
        tx.publish(Buffer.from("# late\n"));
      });
      entered.release();
      return late;
    },
    { signal: controller.signal },
  );
  await entered.promise;
  controller.abort();
  await expect(pending).rejects.toMatchObject({
    reason: "closed",
    replacementAttempted: false,
  });
  await withConfigTransaction(context, (tx) =>
    tx.publish(Buffer.from("# current owner\n")),
  );
  release.release();
  await expect(late).rejects.toBeInstanceOf(ConfigTransactionError);
  expect(readFileSync(context.files.workspace, "utf8")).toBe(
    "# current owner\n",
  );
});

test("callback failure and cancellation after replacement retain attempted/unconfirmed truth", async () => {
  const b = box();
  const context = b.prepare();
  await expect(
    withConfigTransaction(context, (tx) => {
      tx.publish(Buffer.from("# published before callback failure\n"));
      throw Error("failure after publication");
    }),
  ).rejects.toMatchObject({
    reason: "unconfirmed",
    replacementAttempted: true,
  });
  expect(readFileSync(context.files.workspace, "utf8")).toBe(
    "# published before callback failure\n",
  );
  const controller = new AbortController();
  const entered = deferred();
  const pending = withConfigTransaction(
    context,
    (tx) => {
      tx.publish(Buffer.from("# published before cancellation\n"));
      entered.release();
      return new Promise<void>(() => {});
    },
    { signal: controller.signal },
  );
  await entered.promise;
  controller.abort();
  await expect(pending).rejects.toMatchObject({
    reason: "unconfirmed",
    replacementAttempted: true,
  });
  expect(readFileSync(context.files.workspace, "utf8")).toBe(
    "# published before cancellation\n",
  );
  await withConfigTransaction(context, () => {});
});

test("finished publishers are closed and exceptions release the lock", async () => {
  const b = box();
  const context = b.prepare();
  const transactions: ConfigWriteTransaction[] = [];
  await expect(
    withConfigTransaction(context, (tx) => {
      transactions.push(tx);
      throw Error("original failure before publication");
    }),
  ).rejects.toThrow("original failure before publication");
  await withConfigTransaction(context, (tx) => transactions.push(tx));
  for (const tx of transactions)
    expect(() => tx.publish(Buffer.from("# late\n"))).toThrow("closed");
  expect(existsSync(context.files.workspace)).toBe(false);
});
