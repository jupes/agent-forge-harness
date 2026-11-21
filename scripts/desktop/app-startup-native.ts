import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { z } from "zod";
import { runNativeSettingsCommand } from "../projects/repository-onboarding";
import type {
  StartupBackend,
  StartupObservation,
} from "./app-startup-protocol";
import { startupRegistrationSchema } from "./app-startup-protocol";

export function nativeStartupBackend(
  nativeApp: string | undefined,
  cwd: string,
  controls: {
    platform?: string;
    run?: typeof runNativeSettingsCommand;
  } = {},
): StartupBackend | undefined {
  if (
    (controls.platform ?? process.platform) !== "win32" ||
    !nativeApp ||
    !/^[A-Za-z]:\\/.test(nativeApp) ||
    /[\0"\r\n]/.test(nativeApp)
  )
    return undefined;
  const expectedCommand = `"${nativeApp}" --from-login`;
  if (expectedCommand.length > 260) return undefined;
  const run = controls.run ?? runNativeSettingsCommand;
  const schema = z
    .object({
      ok: z.literal(true),
      error: z.null(),
      data: z
        .object({
          version: z.literal(2),
          expectedCommand: z.literal(expectedCommand),
          coordinationParent: z
            .string()
            .min(3)
            .max(3072)
            .refine(
              (path) =>
                /^[A-Za-z]:\\/.test(path) &&
                win32.normalize(path) === path &&
                !/[\0\r\n]/.test(path),
            ),
          outcome: z.enum(["read", "completed", "refused", "unconfirmed"]),
          registration: startupRegistrationSchema.nullable(),
          capability: z.enum(["available", "install-required"]),
          generation: z
            .string()
            .uuid()
            .refine((value) => value === value.toLowerCase())
            .nullable(),
        })
        .strict()
        .refine((value) =>
          value.capability === "install-required"
            ? value.outcome === "read" &&
              value.generation === null &&
              value.registration === null
            : value.generation !== null &&
              (value.registration !== null || value.outcome === "unconfirmed"),
        ),
    })
    .strict();
  async function call(args: string[], signal: AbortSignal) {
    const result = await run(
      [nativeApp!, "--startup-registration", ...args],
      cwd,
      signal,
    );
    if (
      result.exitCode !== 0 ||
      signal.aborted ||
      Buffer.byteLength(result.stdout, "utf8") > 4096
    )
      throw Error("Native startup response unavailable");
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      throw Error("Native startup response invalid");
    }
    return schema.parse(raw).data;
  }
  function observation(
    value: z.infer<typeof schema>["data"],
  ): StartupObservation | null {
    return value.registration === null ||
      value.generation === null ||
      value.capability !== "available"
      ? null
      : {
          installationKey: createHash("sha256")
            .update(expectedCommand + "\0" + value.generation)
            .digest("hex"),
          coordinationHome: win32.join(
            value.coordinationParent,
            ".agent-forge-startup-v1",
          ),
          registration: value.registration,
        };
  }
  return {
    async read(signal) {
      const data = await call(["read"], signal),
        result = observation(data);
      if (data.capability === "install-required")
        return { capability: "unsupported", reason: "install-required" };
      if (data.outcome !== "read" || result === null)
        throw Error("Native startup status unavailable");
      return result;
    },
    async set(enabled, expected, signal, reviewedInstallationKey) {
      if (
        typeof enabled !== "boolean" ||
        !["enabled", "disabled"].includes(expected) ||
        !/^[a-f0-9]{64}$/.test(reviewedInstallationKey)
      )
        throw Error("Invalid native startup request");
      const data = await call(
        [
          "set",
          enabled ? "enabled" : "disabled",
          expected,
          reviewedInstallationKey,
        ],
        signal,
      );
      if (data.outcome === "read")
        throw Error("Native startup completion unavailable");
      return { outcome: data.outcome, observation: observation(data) };
    },
  };
}
