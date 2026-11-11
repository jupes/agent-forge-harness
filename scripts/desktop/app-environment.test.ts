import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { environmentStatusSchema } from "../config/environment-protocol";
import { startTestHearth } from "../hearth/testing";

test("environment Settings uses the protected audited operator table and rejects public selectors", async () => {
  const h = await startTestHearth();
  try {
    const route = `${h.api}/app-settings/environment`;
    const get = () => fetch(route, { headers: h.headers(h.hearth.token) });
    const response = await get();
    expect(response.status).toBe(200);
    const envelope: unknown = await response.json();
    if (
      !envelope ||
      typeof envelope !== "object" ||
      !("ok" in envelope) ||
      envelope.ok !== true ||
      !("data" in envelope)
    )
      throw Error("Missing environment envelope");
    const before = environmentStatusSchema.parse(envelope.data);
    const request = {
      requestId: randomUUID(),
      ownerKey: before.ownerKey,
      expectedRevision: before.revision,
      expectedJournalRevision: before.record.revision,
      names: ["TEAM_TOKEN"],
    };
    const post = (
      body: unknown,
      token: string | null = h.hearth.token,
      suffix = "",
    ) =>
      fetch(route + suffix, {
        method: "POST",
        headers: { ...h.headers(token), "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post(request, "invalid-token")).status).toBe(403);
    expect(
      (await post({ ...request, file: "C:/foreign/config.toml" })).status,
    ).toBe(400);
    expect((await post(request, h.hearth.token, "?target=user")).status).toBe(
      400,
    );
    expect(existsSync(before.file)).toBe(false);
    const saved = await post(request);
    expect(saved.status).toBe(200);
    const result: unknown = await saved.json();
    if (
      !result ||
      typeof result !== "object" ||
      !("ok" in result) ||
      result.ok !== true ||
      !("data" in result)
    )
      throw Error("Missing save envelope");
    expect(environmentStatusSchema.parse(result.data)).toMatchObject({
      names: ["TEAM_TOKEN"],
      record: { last: { request, state: "completed" } },
    });
    expect(
      h
        .events()
        .filter((event) => event.kind === "operator.action")
        .map((event) => event.payload),
    ).toContainEqual(
      expect.objectContaining({
        action: "app.environment.save",
        target: request.requestId,
      }),
    );
    expect(existsSync(join(h.root, "agent-forge.toml"))).toBe(false);
  } finally {
    await h.close();
  }
});
