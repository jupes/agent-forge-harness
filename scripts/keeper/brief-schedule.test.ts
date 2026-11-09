import { expect, test } from "bun:test";
import {
  type KeeperScheduleSaved,
  keeperScheduleInputSchema,
  keeperScheduleSavedSchema,
  keeperScheduleWindow,
} from "./brief-schedule";

const daily: KeeperScheduleSaved = {
  kind: "daily",
  atUtc: "09:30",
  generation: "00000000-0000-4000-8000-000000000001",
  activatedAt: "2026-11-08T00:00:00.000Z",
};
const windowAt = (at: string, saved: unknown = daily) =>
  keeperScheduleWindow(saved, Date.parse(at));

test("Keeper schedule input and saved records are closed UTC contracts", () => {
  expect(keeperScheduleInputSchema.parse({ kind: "off" })).toEqual({
    kind: "off",
  });
  expect(
    keeperScheduleInputSchema.parse({ kind: "daily", atUtc: "09:30" }),
  ).toEqual({ kind: "daily", atUtc: "09:30" });
  expect(keeperScheduleSavedSchema.parse(daily)).toEqual(daily);
  for (const value of [
    daily,
    { kind: "off", generation: daily.generation },
    { kind: "daily", atUtc: "09:30", timezone: "UTC" },
  ])
    expect(keeperScheduleInputSchema.safeParse(value).success).toBe(false);
  for (const atUtc of ["9:30", "24:00", "09:60", "09:30Z", "09:30 "])
    expect(
      keeperScheduleInputSchema.safeParse({ kind: "daily", atUtc }).success,
    ).toBe(false);
  for (const value of [
    { kind: "daily", atUtc: "09:30" },
    { kind: "off", activatedAt: daily.activatedAt },
    { ...daily, generation: "invalid" },
  ])
    expect(keeperScheduleSavedSchema.safeParse(value).success).toBe(false);
  expect(windowAt("2026-11-08T09:30:00.000Z", { kind: "off" })).toEqual({
    latestDueAt: null,
    nextDueAt: null,
  });
});

test("Keeper schedule windows distinguish before, exact and after UTC due time", () => {
  for (const [at, latestDueAt, nextDueAt] of [
    ["2026-11-08T09:29:59.999Z", null, "2026-11-08T09:30:00.000Z"],
    [
      "2026-11-08T09:30:00.000Z",
      "2026-11-08T09:30:00.000Z",
      "2026-11-09T09:30:00.000Z",
    ],
    [
      "2026-11-08T09:30:00.001Z",
      "2026-11-08T09:30:00.000Z",
      "2026-11-09T09:30:00.000Z",
    ],
    [
      "2026-11-10T10:00:00.000Z",
      "2026-11-10T09:30:00.000Z",
      "2026-11-11T09:30:00.000Z",
    ],
  ] as const) {
    if (!at) throw Error("Missing clock fixture");
    expect(windowAt(at)).toEqual({ latestDueAt, nextDueAt });
  }
});

test("Keeper schedule activation bounds both due slots through clock rollback", () => {
  for (const [activatedAt, latestDueAt, nextDueAt] of [
    [
      "2026-11-08T09:29:59.999Z",
      "2026-11-08T09:30:00.000Z",
      "2026-11-09T09:30:00.000Z",
    ],
    [
      "2026-11-08T09:30:00.000Z",
      "2026-11-08T09:30:00.000Z",
      "2026-11-09T09:30:00.000Z",
    ],
    ["2026-11-08T09:30:00.001Z", null, "2026-11-09T09:30:00.000Z"],
    ["2026-11-12T10:00:00.000Z", null, "2026-11-13T09:30:00.000Z"],
  ] as const)
    expect(
      windowAt("2026-11-08T09:30:00.000Z", { ...daily, activatedAt }),
    ).toEqual({ latestDueAt, nextDueAt });
  expect(
    windowAt("2026-11-01T00:00:00.000Z", {
      ...daily,
      activatedAt: "2026-11-12T09:30:00.000Z",
    }),
  ).toEqual({ latestDueAt: null, nextDueAt: "2026-11-12T09:30:00.000Z" });
});

test("Keeper schedule midnight slots follow UTC leap days", () => {
  const midnight = {
    ...daily,
    atUtc: "00:00",
    activatedAt: "2028-02-28T00:00:00.000Z",
  };
  expect(windowAt("2028-02-28T23:59:59.999Z", midnight)).toEqual({
    latestDueAt: "2028-02-28T00:00:00.000Z",
    nextDueAt: "2028-02-29T00:00:00.000Z",
  });
  expect(windowAt("2028-02-29T00:00:00.000Z", midnight)).toEqual({
    latestDueAt: "2028-02-29T00:00:00.000Z",
    nextDueAt: "2028-03-01T00:00:00.000Z",
  });
});
