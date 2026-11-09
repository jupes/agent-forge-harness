import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  type TrackerIdentity,
  trackerIdentitySchema,
} from "./complete-tracker-source";

export interface OwnTrackerDescriptor extends TrackerIdentity {
  root: string;
  port: number;
  fingerprint: string;
}
const metadataSchema = z
  .object({
    backend: z.literal("dolt"),
    dolt_mode: z.literal("server"),
    dolt_database: trackerIdentitySchema.shape.database,
    project_id: z.uuid(),
    dolt_server_host: z.literal("127.0.0.1").optional(),
    dolt_server_user: z.literal("root").optional(),
    dolt_server_port: z.number().int().min(1).max(65535).optional(),
  })
  .passthrough();
const refused = () =>
  new Error("A supported initialized own-workspace tracker is unavailable.");
function file(path: string, optional = false): string {
  if (optional && !existsSync(path)) return "";
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384)
    throw refused();
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text) > 16384) throw refused();
  return text;
}

/** Own trusted Hearth root only; catalog/repository paths never call this. */
export function captureOwnTracker(root: string): OwnTrackerDescriptor {
  try {
    const canonical = realpathSync(resolve(root)),
      beads = join(canonical, ".beads");
    const stat = lstatSync(beads);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      existsSync(join(beads, "redirect")) ||
      existsSync(join(beads, ".env"))
    )
      throw refused();
    const metadataText = file(join(beads, "metadata.json"));
    let json: unknown;
    try {
      json = JSON.parse(metadataText);
    } catch {
      throw refused();
    }
    const metadata = metadataSchema.parse(json);
    // Credentials, sockets, remote/TLS and proxied routes are not silently guessed.
    for (const [key, value] of Object.entries(metadata))
      if (
        /password|socket|tls|proxied|data_dir/i.test(key) &&
        value !== undefined &&
        value !== null &&
        value !== "" &&
        value !== false
      )
        throw refused();
    const configText = file(join(beads, "config.yaml"), true);
    const config: unknown = configText ? parseYaml(configText) : {};
    if (config === null || typeof config !== "object" || Array.isArray(config))
      throw refused();
    for (const [key, value] of Object.entries(config)) {
      if (
        /^(dolt\.(server|host|port|user|password|database|data-dir)|db$|backend$|directory$)/i.test(
          key,
        ) &&
        value !== undefined &&
        value !== null
      )
        throw refused();
    }
    const portText = file(join(beads, "dolt-server.port"));
    if (!/^[1-9]\d{0,4}\s*$/.test(portText)) throw refused();
    const port = Number(portText.trim());
    if (
      port > 65535 ||
      (metadata.dolt_server_port !== undefined &&
        metadata.dolt_server_port !== port)
    )
      throw refused();
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([canonical, metadataText, configText, portText]))
      .digest("hex");
    return Object.freeze({
      root: canonical,
      port,
      database: metadata.dolt_database,
      projectId: metadata.project_id,
      fingerprint,
    });
  } catch {
    throw refused();
  }
}

export function sameOwnTracker(expected: OwnTrackerDescriptor): boolean {
  try {
    const actual = captureOwnTracker(expected.root);
    return (
      actual.fingerprint === expected.fingerprint &&
      actual.port === expected.port &&
      actual.projectId === expected.projectId &&
      actual.database === expected.database
    );
  } catch {
    return false;
  }
}
