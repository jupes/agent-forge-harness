import { createHash } from "node:crypto";
import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[a-f0-9]{40}$/);
const relative = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((path) =>
    path.split("/").every((part) => part && part !== "." && part !== ".."),
  );
const sourceUrl = z.string().url().max(2048).startsWith("https://");
export const nativeOriginalProofSchema = z.strictObject({
  sourceUrl,
  gitBlobSha1: revision.nullable(),
  crateRevision: revision,
  archiveChecksum: hash,
});
export type NativeOriginalProof = z.infer<typeof nativeOriginalProofSchema>;
const catalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  scope: z.string().min(1).max(512),
  files: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9-]{1,100}$/),
        path: relative,
        output: z
          .string()
          .regex(/^(LICENSE|LICENCE|COPYING|NOTICE)(?:[-_.][A-Za-z0-9._-]+)?$/),
        sourceUrl,
        gitBlobSha1: revision.nullable(),
        bytes: z
          .number()
          .int()
          .positive()
          .max(1024 * 1024),
        sha256: hash,
      }),
    )
    .max(64),
  packages: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
        version: z.string().regex(/^[0-9A-Za-z.+-]{1,100}$/),
        checksum: hash,
        license: z.string().min(1).max(512),
        vcsRevision: revision,
        files: z.array(z.string().min(1).max(100)).min(1).max(16),
      }),
    )
    .max(64),
});

/** Exact archive bindings reviewed against their upstream VCS records; no build-time network. */
export function collectPinnedNativeOriginals(
  raw: unknown,
  identity: {
    name: string;
    version: string;
    checksum: string;
    license: string | null;
  },
  read: (path: string, maxBytes: number) => Uint8Array,
): { path: string; contents: Uint8Array; origin: NativeOriginalProof }[] {
  const catalog = catalogSchema.parse(raw);
  const files = new Map(catalog.files.map((file) => [file.id, file]));
  const paths = new Set(catalog.files.map((file) => file.path.toLowerCase()));
  const packages = new Set(
    catalog.packages.map((pkg) => pkg.name + "@" + pkg.version),
  );
  if (
    files.size !== catalog.files.length ||
    paths.size !== files.size ||
    packages.size !== catalog.packages.length
  )
    throw Error("Ambiguous native original catalog");
  const binding = catalog.packages.find(
    (pkg) => pkg.name === identity.name && pkg.version === identity.version,
  );
  if (!binding) return [];
  if (
    binding.checksum !== identity.checksum ||
    binding.license !== identity.license
  )
    throw Error("Unreviewed native original binding");
  const outputs = new Set<string>();
  return binding.files.map((id) => {
    const file = files.get(id);
    if (!file || outputs.has(file.output.toLowerCase()))
      throw Error("Ambiguous native original binding");
    outputs.add(file.output.toLowerCase());
    const contents = Uint8Array.from(read(file.path, file.bytes));
    const blob = createHash("sha1")
      .update("blob " + contents.length + "\0")
      .update(contents)
      .digest("hex");
    if (
      contents.length !== file.bytes ||
      createHash("sha256").update(contents).digest("hex") !== file.sha256 ||
      (file.gitBlobSha1 !== null && blob !== file.gitBlobSha1)
    )
      throw Error("Native original identity mismatch");
    if (
      new TextDecoder("utf-8", { fatal: true }).decode(contents).includes("\0")
    )
      throw Error("Non-text native original");
    return {
      path: "upstream/" + file.output,
      contents,
      origin: {
        sourceUrl: file.sourceUrl,
        gitBlobSha1: file.gitBlobSha1,
        crateRevision: binding.vcsRevision,
        archiveChecksum: binding.checksum,
      },
    };
  });
}
