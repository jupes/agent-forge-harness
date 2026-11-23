import { z } from "zod";
import type { BdExportRow } from "../beads-dashboard";

export const COMPLETE_TRACKER_BYTES = 16 * 1024 * 1024;
const tables = [
  "issues",
  "wisps",
  "labels",
  "wisp_labels",
  "dependencies",
  "wisp_dependencies",
] as const;
const countsSchema = z
  .object({
    issues: z.number().int().min(0).max(100000),
    wisps: z.number().int().min(0).max(100000),
    labels: z.number().int().min(0).max(400000),
    wisp_labels: z.number().int().min(0).max(400000),
    dependencies: z.number().int().min(0).max(200000),
    wisp_dependencies: z.number().int().min(0).max(200000),
  })
  .strict();
export const trackerIdentitySchema = z
  .object({
    database: z.string().regex(/^[a-zA-Z0-9_]{1,128}$/),
    projectId: z.uuid(),
  })
  .strict();
export type TrackerIdentity = z.infer<typeof trackerIdentitySchema>;
const manifestSchema = trackerIdentitySchema
  .extend({ version: z.literal(1), counts: countsSchema })
  .strict();
const id = z.string().min(1).max(512),
  text = z.string().max(1024 * 1024);
const timestamp = z.iso.datetime({ offset: true });
const issueSchema = z
  .object({
    id,
    title: z.string().min(1).max(8192),
    status: z.string().min(1).max(128),
    issue_type: z.string().min(1).max(128),
    priority: z.number().int().min(0).max(4),
    description: text,
    acceptance_criteria: text,
    notes: text,
    comment_count: z.number().int().min(0).max(1000000),
    comments: z
      .array(
        z
          .object({
            issue_id: id,
            text: z.string().max(16384),
            author: z.string().max(1024),
            created_at: timestamp,
          })
          .strict(),
      )
      .max(100),
    owner: z.string().max(8192).nullable(),
    assignee: z.string().max(8192).nullable(),
    estimated_minutes: z.number().int().min(0).nullable(),
    metadata: z
      .object({
        queue_state: z.string().max(128).nullable(),
        queue_resume: z.string().max(128).nullable(),
        smith: z.string().max(512).nullable(),
      })
      .strict(),
  })
  .strict();
const labelSchema = z
  .object({ issue_id: id, label: z.string().min(1).max(8192) })
  .strict();
const edgeSchema = z
  .object({
    id,
    issue_id: id,
    type: z.string().min(1).max(128),
    depends_on_issue_id: id.nullable(),
    depends_on_wisp_id: id.nullable(),
    depends_on_external: id.nullable(),
  })
  .strict();
const rowSchema = z
  .object({
    part: z.enum(["manifest", ...tables]),
    payload: z.string().max(4 * 1024 * 1024),
    created_at: timestamp.nullable(),
    updated_at: timestamp.nullable(),
    due_at: timestamp.nullable(),
  })
  .strict();
export type CompleteBeadRow = BdExportRow & {
  created_at: string;
  updated_at: string;
  labels: string[];
  dependencies: NonNullable<BdExportRow["dependencies"]>;
  notes: string;
  metadata: Record<string, string>;
};
export interface CompleteTracker {
  identity: TrackerIdentity;
  rows: CompleteBeadRow[];
}

// These identifiers are module constants, never renderer/HTTP/CLI query input.
// One statement provides the manifest and all six table families in one read view.
const body = (table: "issues" | "wisps") => {
  const comments = table === "issues" ? "comments" : "wisp_comments";
  // Embedded comments are a bounded fallback, never the authoritative detail read.
  // Their timestamps use the same UTC DATETIME interpretation as the pinned driver.
  return `JSON_OBJECT('id', id, 'title', title, 'status', status, 'issue_type', issue_type, 'priority', priority, 'description', description, 'acceptance_criteria', acceptance_criteria, 'notes', notes, 'owner', owner, 'assignee', assignee, 'estimated_minutes', estimated_minutes, 'metadata', JSON_OBJECT('queue_state', JSON_EXTRACT(metadata, '$.queue_state'), 'queue_resume', JSON_EXTRACT(metadata, '$.queue_resume'), 'smith', JSON_EXTRACT(metadata, '$.smith')), 'comment_count', (SELECT COUNT(*) FROM ${comments} c WHERE c.issue_id = ${table}.id), 'comments', (SELECT CASE WHEN COUNT(*) <= 100 AND COALESCE(SUM(OCTET_LENGTH(c.text)), 0) <= 65536 AND COALESCE(MAX(OCTET_LENGTH(c.text)), 0) <= 16384 AND COUNT(*) = COUNT(c.created_at) THEN COALESCE(JSON_ARRAYAGG(JSON_OBJECT('issue_id', c.issue_id, 'text', c.text, 'author', COALESCE(c.author, ''), 'created_at', DATE_FORMAT(c.created_at, '%Y-%m-%dT%H:%i:%s.%fZ'))), JSON_ARRAY()) ELSE JSON_ARRAY() END FROM ${comments} c WHERE c.issue_id = ${table}.id))`;
};
const issueSelect = (table: "issues" | "wisps") =>
  `SELECT '${table}', CAST(CASE WHEN OCTET_LENGTH(description) + OCTET_LENGTH(acceptance_criteria) + OCTET_LENGTH(notes) <= 3145728 THEN ${body(table)} ELSE NULL END AS CHAR), created_at, updated_at, due_at FROM ${table}`;
const labelSelect = (table: "labels" | "wisp_labels") =>
  `SELECT '${table}', CAST(JSON_OBJECT('issue_id', issue_id, 'label', label) AS CHAR), NULL, NULL, NULL FROM ${table}`;
const edgeSelect = (table: "dependencies" | "wisp_dependencies") =>
  `SELECT '${table}', CAST(JSON_OBJECT('id', id, 'issue_id', issue_id, 'type', type, 'depends_on_issue_id', depends_on_issue_id, 'depends_on_wisp_id', depends_on_wisp_id, 'depends_on_external', depends_on_external) AS CHAR), NULL, NULL, NULL FROM ${table}`;
const snapshotParts = [
  `SELECT 'manifest' AS part, CAST(JSON_OBJECT('version', 1, 'database', DATABASE(), 'projectId', (SELECT value FROM metadata WHERE \`key\` = '_project_id'), 'counts', JSON_OBJECT(${tables.map((table) => `'${table}', (SELECT COUNT(*) FROM ${table})`).join(", ")})) AS CHAR) AS payload, NULL AS created_at, NULL AS updated_at, NULL AS due_at`,
  issueSelect("issues"),
  issueSelect("wisps"),
  labelSelect("labels"),
  labelSelect("wisp_labels"),
  edgeSelect("dependencies"),
  edgeSelect("wisp_dependencies"),
].join(" UNION ALL ");
// Bound serialized receiving size BEFORE the driver materializes result rows.
// JSON_QUOTE counts the payload string escaping;256 covers keys/timestamps/part.
export const COMPLETE_TRACKER_SQL = `WITH tracker_parts AS (${snapshotParts}) SELECT * FROM tracker_parts WHERE (SELECT COALESCE(SUM(COALESCE(OCTET_LENGTH(JSON_QUOTE(payload)), 4) + 256), 0) FROM tracker_parts) <= ${COMPLETE_TRACKER_BYTES} LIMIT 700002`;

function refuse(): never {
  throw new Error("The tracker snapshot is unavailable or incomplete.");
}
function json(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return refuse();
  }
}

/** A missing table/count/identity is unavailable, including when every row is empty. */
export function parseCompleteTracker(
  stdout: string,
  expected: TrackerIdentity,
): CompleteTracker {
  try {
    trackerIdentitySchema.parse(expected);
    if (Buffer.byteLength(stdout) > COMPLETE_TRACKER_BYTES) return refuse();
    const raw: unknown = json(stdout);
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 700001)
      return refuse();
    const parts = raw.map((row) => rowSchema.parse(row));
    const manifests = parts.filter((row) => row.part === "manifest");
    if (manifests.length !== 1) return refuse();
    const manifest = manifestSchema.parse(json(manifests[0]!.payload));
    if (
      manifest.database !== expected.database ||
      manifest.projectId !== expected.projectId
    )
      return refuse();
    for (const table of tables)
      if (
        parts.filter((row) => row.part === table).length !==
        manifest.counts[table]
      )
        return refuse();
    if (
      manifest.counts.issues + manifest.counts.wisps > 100000 ||
      manifest.counts.labels + manifest.counts.wisp_labels > 400000 ||
      manifest.counts.dependencies + manifest.counts.wisp_dependencies > 200000
    )
      return refuse();
    const rows = new Map<string, CompleteBeadRow>(),
      families = new Map<string, string>();
    for (const part of parts) {
      if (part.part !== "issues" && part.part !== "wisps") {
        if (
          part.created_at !== null ||
          part.updated_at !== null ||
          part.due_at !== null
        )
          return refuse();
        continue;
      }
      const value = issueSchema.parse(json(part.payload));
      if (!part.created_at || !part.updated_at || rows.has(value.id))
        return refuse();
      if (
        value.comments.some((comment) => comment.issue_id !== value.id) ||
        value.comments.length > value.comment_count
      )
        return refuse();
      const metadata = Object.fromEntries(
        Object.entries(value.metadata).filter(
          (entry): entry is [string, string] => entry[1] !== null,
        ),
      );
      rows.set(value.id, {
        id: value.id,
        title: value.title,
        status: value.status,
        issue_type: value.issue_type,
        priority: value.priority,
        description: value.description,
        ...(value.acceptance_criteria === ""
          ? {}
          : { acceptance_criteria: value.acceptance_criteria }),
        notes: value.notes,
        comment_count: value.comment_count,
        comments: value.comments,
        ...(value.owner ? { owner: value.owner } : {}),
        ...(value.assignee ? { assignee: value.assignee } : {}),
        ...(value.estimated_minutes === null
          ? {}
          : { estimate: value.estimated_minutes }),
        created_at: part.created_at,
        updated_at: part.updated_at,
        ...(part.due_at === null ? {} : { due_at: part.due_at }),
        metadata,
        labels: [],
        dependencies: [],
      });
      families.set(value.id, part.part);
    }
    const labels = new Set<string>(),
      edges = new Set<string>(),
      edgeIds = new Set<string>(),
      parents = new Map<string, string>();
    for (const part of parts) {
      if (part.part === "labels" || part.part === "wisp_labels") {
        const value = labelSchema.parse(json(part.payload)),
          row = rows.get(value.issue_id);
        const key = JSON.stringify([value.issue_id, value.label]);
        if (
          !row ||
          families.get(value.issue_id) !==
            (part.part === "labels" ? "issues" : "wisps") ||
          labels.has(key)
        )
          return refuse();
        labels.add(key);
        row.labels.push(value.label);
      } else if (
        part.part === "dependencies" ||
        part.part === "wisp_dependencies"
      ) {
        const value = edgeSchema.parse(json(part.payload)),
          row = rows.get(value.issue_id);
        const target = [
          value.depends_on_issue_id,
          value.depends_on_wisp_id,
          value.depends_on_external,
        ].filter((item) => item !== null);
        const key = JSON.stringify([value.issue_id, value.type, target]),
          edgeId = JSON.stringify([part.part, value.id]);
        if (
          !row ||
          families.get(value.issue_id) !==
            (part.part === "dependencies" ? "issues" : "wisps") ||
          target.length !== 1 ||
          edges.has(key) ||
          edgeIds.has(edgeId)
        )
          return refuse();
        if (
          value.depends_on_issue_id !== null &&
          families.get(value.depends_on_issue_id) !== "issues"
        )
          return refuse();
        if (
          value.depends_on_wisp_id !== null &&
          families.get(value.depends_on_wisp_id) !== "wisps"
        )
          return refuse();
        if (value.type === "parent-child") {
          if (value.depends_on_external !== null || parents.has(value.issue_id))
            return refuse();
          parents.set(value.issue_id, target[0]!);
        }
        edges.add(key);
        edgeIds.add(edgeId);
        row.dependencies.push({
          issue_id: value.issue_id,
          depends_on_id: target[0]!,
          type: value.type,
        });
      }
    }
    for (const row of rows.values()) row.labels.sort();
    return {
      identity: { database: manifest.database, projectId: manifest.projectId },
      rows: [...rows.values()],
    };
  } catch {
    return refuse();
  }
}
