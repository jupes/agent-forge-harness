import { expect, test } from "bun:test";
import {
  completeFixtureModel,
  completeFixtureReader,
} from "../projects/complete-tracker-test-model";
import { seedProjectBeadWriteFixture } from "./routes/project-bead-write-fixture";
import { fakeBd } from "./testing";

test("project write fixture establishes a closed-world complete source after preceding partial write fixtures", async () => {
  const bd = fakeBd();
  await bd.run([
    "create",
    "--title=Fixture bead",
    "--type=task",
    "--priority=2",
    "--parent=demo-epic",
    "--json",
  ]);
  expect(bd.issues.size).toBe(1);
  seedProjectBeadWriteFixture({ bd });
  const before = bd.calls.length,
    answer = await bd.run(["export", "--readonly", "--no-memories"]);
  const complete = completeFixtureModel(answer);
  expect(complete.rows.map((row) => row.id).sort()).toEqual([
    "alpha-epic",
    "alpha-propose",
    "alpha-task",
    "beta-epic",
  ]);
  expect(
    complete.rows.find((row) => row.id === "alpha-task")!.dependencies,
  ).toEqual([
    {
      issue_id: "alpha-task",
      depends_on_id: "alpha-epic",
      type: "parent-child",
    },
  ]);
  expect(bd.calls.length).toBe(before + 1);
});

test("complete lifecycle fixture reads only when requested and holds the real producer boundary", async () => {
  let calls = 0,
    loads = 0,
    release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const reader = completeFixtureReader(
    async (args) => {
      calls++;
      expect(args).toEqual(["export", "--readonly", "--no-memories"]);
      return {
        status: 0,
        stderr: "",
        stdout: JSON.stringify({
          id: "epic",
          title: "Fixture",
          status: "open",
          issue_type: "epic",
          labels: ["project:alpha"],
        }),
      };
    },
    async () => {
      loads++;
      await held;
    },
  );
  expect(calls).toBe(0);
  expect(loads).toBe(0);
  const pending = reader();
  expect(loads).toBe(1);
  expect(calls).toBe(0);
  let done = false;
  void pending.then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  release();
  expect((await pending).rows[0]!.id).toBe("epic");
  expect(calls).toBe(1);
  expect(loads).toBe(1);
});
