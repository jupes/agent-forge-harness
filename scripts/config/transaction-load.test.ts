import { expect, test } from "bun:test";
import { loadConfigFromByteContents, loadConfigFromContents } from "./load";

test("captured scalar validation reports a user semantic failure before decoding a later UTF-16 layer", () => {
  expect(() =>
    loadConfigFromByteContents({
      sources: {
        user: {
          file: "captured-user.toml",
          bytes: Buffer.from("[shift]\nrepairs = -1\n"),
        },
        workspace: {
          file: "captured-workspace.toml",
          bytes: Buffer.from([0xff, 0xfe, 0x61, 0]),
        },
      },
      env: {},
    }),
  ).toThrow("captured-user.toml: shift.repairs");
});

test("captured raw scalar layers match explicit text loading including absent layers and env-pass", () => {
  const user = '[execution.env]\npass = ["EXPLICIT"]\n';
  for (const workspace of [null, "", "[shift]\nmax_beads = 3\n"]) {
    const expected = loadConfigFromContents({
      sources: {
        user: { file: "user.toml", text: user },
        workspace: { file: "workspace.toml", text: workspace },
      },
      env: { AGENT_FORGE_SMITH: "codex-journeyman" },
    });
    expect(
      loadConfigFromByteContents({
        sources: {
          user: { file: "user.toml", bytes: Buffer.from(user) },
          workspace: {
            file: "workspace.toml",
            bytes: workspace === null ? null : Buffer.from(workspace),
          },
        },
        env: { AGENT_FORGE_SMITH: "codex-journeyman" },
      }),
    ).toEqual(expected);
  }
});
