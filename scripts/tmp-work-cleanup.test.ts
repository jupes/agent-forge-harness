import { describe, expect, test } from "bun:test";
import type { BeadsIssue } from "../types/beads";
import { classifyFile } from "./tmp-work-cleanup";

const mkClosed = (id: string): BeadsIssue => ({
  id,
  type: "task",
  title: id,
  status: "closed",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-10T00:00:00Z",
});

const mkOpen = (id: string): BeadsIssue => ({ ...mkClosed(id), status: "open" });

describe("classifyFile", () => {
  test("skips session-handoff.md", () => {
    const r = classifyFile("session-handoff.md", 100, new Map(), 14);
    expect(r).toBeNull();
  });

  test("skips <EPIC>-interfaces.md", () => {
    const r = classifyFile("agent-forge-harness-c8u-interfaces.md", 100, new Map(), 14);
    expect(r).toBeNull();
  });

  test("skips unknown prefix", () => {
    const r = classifyFile("random.md", 100, new Map(), 14);
    expect(r).toBeNull();
  });

  test("deletes closed task above TTL", () => {
    const m = new Map<string, BeadsIssue>();
    m.set("agent-forge-harness-jq3", mkClosed("agent-forge-harness-jq3"));
    const r = classifyFile(
      "agent-forge-harness-jq3-verdict.json",
      20,
      m,
      14,
    );
    expect(r?.action).toBe("delete");
  });

  test("skips open task even if old", () => {
    const m = new Map<string, BeadsIssue>();
    m.set("agent-forge-harness-jq3", mkOpen("agent-forge-harness-jq3"));
    const r = classifyFile(
      "agent-forge-harness-jq3-alignment.md",
      99,
      m,
      14,
    );
    expect(r?.action).toBe("skip");
    expect(r?.reason).toContain("status=open");
  });

  test("skips closed but under TTL", () => {
    const m = new Map<string, BeadsIssue>();
    m.set("agent-forge-harness-jq3", mkClosed("agent-forge-harness-jq3"));
    const r = classifyFile(
      "agent-forge-harness-jq3-plan.md",
      5,
      m,
      14,
    );
    expect(r?.action).toBe("skip");
  });
});
