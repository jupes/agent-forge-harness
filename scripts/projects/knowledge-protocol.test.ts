import { expect, test } from "bun:test";
import { parse } from "yaml";
import {
  buildKnowledgeYaml,
  generatedKnowledgeSchema,
  knowledgeReceiptSchema,
  knowledgeRefreshRequestSchema,
} from "./knowledge-protocol";

const generated = {
  overview: {
    name: "alpha",
    description: "A bounded fixture application.",
    purpose: "tooling",
    tech_stack: {
      runtime: "bun",
      framework: "unknown",
      language: "typescript",
      key_libraries: ["yaml: observed manifest"],
    },
  },
  architecture: {
    structure: "src/\n  index.ts",
    entry_points: ["src/index.ts: observed entry"],
    key_components: ["index: command entry"],
  },
  patterns: {
    error_handling: "unknown",
    state_management: "unknown",
    module_organization: "unknown",
    authentication: "unknown",
    testing: "bun test",
  },
  conventions: {
    commit_format: "unknown",
    branch_naming: "unknown",
    pr_requirements: [],
    coding_standards: [],
  },
  integration_points: { apis: [], shared_types: [], events: [] },
  key_files: [
    {
      path: "src/index.ts",
      description: "Observed entry point",
      key_exports: [],
    },
  ],
  recent_changes: ["abcdef0: observed fixture commit"],
};
const confirmedReceipt = {
  projectId: "project-10000000-0000-4000-8000-000000000001",
  requestId: "10000000-0000-4000-8000-000000000002",
  requestHash: "a".repeat(64),
  repositoryKey: "b".repeat(64),
  state: "confirmed",
  sourceCommit: "c".repeat(40),
  evidenceHash: "d".repeat(64),
  candidateHash: "e".repeat(64),
  confirmedAt: "2026-11-07T00:00:00.000Z",
  message: "Exact candidate confirmed.",
  retainedExtensions: [],
};
test("a confirmed knowledge receipt requires the exact candidate hash as evidence", () => {
  expect(knowledgeReceiptSchema.safeParse(confirmedReceipt).success).toBe(true);
  expect(
    knowledgeReceiptSchema.safeParse({
      ...confirmedReceipt,
      candidateHash: null,
    }).success,
  ).toBe(false);
});

test("knowledge receipt phases require compatible candidate and confirmation evidence", () => {
  expect(
    knowledgeReceiptSchema.safeParse({
      ...confirmedReceipt,
      confirmedAt: null,
    }).success,
  ).toBe(false);
  for (const state of ["reserved", "attempted", "generation-completed"]) {
    const receipt = {
      ...confirmedReceipt,
      state,
      candidateHash: null,
      confirmedAt: null,
    };
    expect(knowledgeReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(
      knowledgeReceiptSchema.safeParse({
        ...receipt,
        candidateHash: confirmedReceipt.candidateHash,
      }).success,
    ).toBe(false);
    expect(
      knowledgeReceiptSchema.safeParse({
        ...receipt,
        confirmedAt: confirmedReceipt.confirmedAt,
      }).success,
    ).toBe(false);
  }
  for (const state of ["candidate-saved", "publishing"]) {
    const receipt = { ...confirmedReceipt, state, confirmedAt: null };
    expect(knowledgeReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(
      knowledgeReceiptSchema.safeParse({
        ...receipt,
        candidateHash: null,
      }).success,
    ).toBe(false);
    expect(
      knowledgeReceiptSchema.safeParse({
        ...receipt,
        confirmedAt: confirmedReceipt.confirmedAt,
      }).success,
    ).toBe(false);
  }
  for (const state of ["unknown", "failed", "refused"]) {
    for (const candidateHash of [null, confirmedReceipt.candidateHash])
      expect(
        knowledgeReceiptSchema.safeParse({
          ...confirmedReceipt,
          state,
          candidateHash,
          confirmedAt: null,
        }).success,
      ).toBe(true);
    expect(
      knowledgeReceiptSchema.safeParse({
        ...confirmedReceipt,
        state,
      }).success,
    ).toBe(false);
  }
});

test("knowledge refresh accepts identity metadata only and generates all canonical sections with server provenance", () => {
  expect(
    knowledgeRefreshRequestSchema.safeParse({
      requestId: "10000000-0000-4000-8000-000000000001",
      expectedRevision: 2,
      repositoryKey: "a".repeat(64),
    }).success,
  ).toBe(true);
  expect(
    knowledgeRefreshRequestSchema.safeParse({
      requestId: "10000000-0000-4000-8000-000000000001",
      expectedRevision: 2,
      repositoryKey: "a".repeat(64),
      outputPath: "/foreign",
    }).success,
  ).toBe(false);
  const yaml = buildKnowledgeYaml({
    generated,
    prior: null,
    name: "alpha",
    sourceCommit: "a".repeat(40),
    evidenceHash: "b".repeat(64),
    generatedAt: "2026-11-06T00:00:00.000Z",
  });
  expect(parse(yaml.text)).toEqual(generated);
  expect(yaml.text).toContain("# Commit: " + "a".repeat(40));
  expect(yaml.text).toContain("Bounded evidence");
  expect(yaml.text.split("\n").length).toBeLessThanOrEqual(400);
});
test("legacy extension sections survive full core regeneration and unsupported extension shapes refuse without erasure", () => {
  const prior = {
    ...generated,
    overview: {
      ...generated.overview,
      description: "Old description",
      upstream: { url: "https://example.test/alpha" },
    },
    integration_points: {
      ...generated.integration_points,
      ecosystem: ["original integration"],
    },
    design_tokens: { colors: { brand: "#123456" } },
  };
  const yaml = buildKnowledgeYaml({
    generated,
    prior,
    name: "alpha",
    sourceCommit: "a".repeat(40),
    evidenceHash: "b".repeat(64),
    generatedAt: "2026-11-06T00:00:00.000Z",
  });
  expect(parse(yaml.text)).toMatchObject({
    overview: {
      description: generated.overview.description,
      upstream: prior.overview.upstream,
    },
    integration_points: { ecosystem: prior.integration_points.ecosystem },
    design_tokens: prior.design_tokens,
  });
  expect(yaml.retainedExtensions).toEqual([
    "design_tokens",
    "integration_points.ecosystem",
    "overview.upstream",
  ]);
  expect(yaml.text).toContain("unverified legacy extensions");
  for (const prior of [
    {
      ...generated,
      architecture: {
        ...generated.architecture,
        entry_points: [
          { "src/index.ts": "legacy mapping", custom_notes: "Retain this" },
        ],
      },
    },
    {
      ...generated,
      overview: {
        ...generated.overview,
        tech_stack: {
          ...generated.overview.tech_stack,
          key_libraries: [
            { yaml: "legacy version", custom_notes: "Retain this" },
          ],
        },
      },
    },
    {
      ...generated,
      key_files: [
        {
          ...generated.key_files[0],
          key_exports: [
            { entry: "legacy mapping", custom_notes: "Retain this" },
          ],
        },
      ],
    },
  ])
    expect(() =>
      buildKnowledgeYaml({
        generated,
        prior,
        name: "alpha",
        sourceCommit: "a".repeat(40),
        evidenceHash: "b".repeat(64),
        generatedAt: "2026-11-06T00:00:00.000Z",
      }),
    ).toThrow("extension");
  expect(() =>
    buildKnowledgeYaml({
      generated,
      prior: {
        ...generated,
        key_files: [{ ...generated.key_files[0], custom_notes: "Preserve me" }],
      },
      name: "alpha",
      sourceCommit: "a".repeat(40),
      evidenceHash: "b".repeat(64),
      generatedAt: "2026-11-06T00:00:00.000Z",
    }),
  ).toThrow("extension");
});
test("generated paths, prototype keys, oversized or incomplete knowledge never become a candidate", () => {
  expect(
    generatedKnowledgeSchema.safeParse({
      ...generated,
      key_files: [
        { path: "../private", description: "unsafe", key_exports: [] },
      ],
    }).success,
  ).toBe(false);
  expect(
    generatedKnowledgeSchema.safeParse({
      ...generated,
      architecture: undefined,
    }).success,
  ).toBe(false);
  const request = {
    generated,
    prior: null,
    name: "different",
    sourceCommit: "a".repeat(40),
    evidenceHash: "b".repeat(64),
    generatedAt: "2026-11-06T00:00:00.000Z",
  };
  expect(() => buildKnowledgeYaml(request)).toThrow("name");
  expect(() =>
    buildKnowledgeYaml({
      ...request,
      name: "alpha",
      prior: (() => {
        try {
          return JSON.parse('{"__proto__":{"unsafe":true}}');
        } catch {
          throw Error("Invalid unsafe fixture");
        }
      })(),
    }),
  ).toThrow();
  expect(() =>
    buildKnowledgeYaml({
      ...request,
      name: "alpha",
      generated: {
        ...generated,
        architecture: {
          ...generated.architecture,
          structure: Array(401).fill("line").join("\n"),
        },
      },
    }),
  ).toThrow();
});
