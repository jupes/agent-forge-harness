import { z } from "zod";
import { compareReleaseVersions, parseReleaseVersion } from "./release-version";

export const RELEASE_URL_PREFIX =
  "https://github.com/jupes/agent-forge-harness/releases/tag/";
export const officialReleaseUrl = (tag: string) =>
  RELEASE_URL_PREFIX + encodeURIComponent(tag);
const stableTag = z
  .string()
  .max(128)
  .refine((value) => {
    const parsed = parseReleaseVersion(value);
    return parsed !== null && parsed.pre.length === 0;
  });
const common = {
  checkedAt: z.string().datetime(),
  currentVersion: z.string().min(1).max(128),
};
const release = z
  .object({
    tag: stableTag,
    url: z.string().max(1024),
    publishedAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (value) => value.url === officialReleaseUrl(value.tag),
    "Expected official release URL",
  );
export const appUpdateResultSchema = z
  .discriminatedUnion("state", [
    z.object({ ...common, state: z.literal("newer"), release }).strict(),
    z.object({ ...common, state: z.literal("equal"), release }).strict(),
    z.object({ ...common, state: z.literal("ahead"), release }).strict(),
    z
      .object({
        ...common,
        state: z.literal("unavailable"),
        reason: z.enum([
          "network",
          "timeout",
          "not-found",
          "rate-limited",
          "invalid-response",
          "unsupported-version",
          "closed",
        ]),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.state === "unavailable") return;
    const order = compareReleaseVersions(
      value.currentVersion,
      value.release.tag,
    );
    if (
      order === null ||
      value.state !== (order < 0 ? "newer" : order === 0 ? "equal" : "ahead")
    )
      context.addIssue({
        code: "custom",
        message: "Inconsistent release comparison",
      });
  });
export type AppUpdateResult = z.infer<typeof appUpdateResultSchema>;
export type AppUpdateCheck = () => Promise<AppUpdateResult>;
