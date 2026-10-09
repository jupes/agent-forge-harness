import { dirname } from "node:path";
import { expect, test } from "@playwright/test";
import { rootKey } from "../../scripts/hearth/home";
import { HEALTH_ROUTE } from "../../scripts/hearth/paths";
import { HEARTH_URL } from "./servers";

/**
 * The servers under test are the ones this checkout's config started.
 *
 * Every other spec would still pass against a dashboard that had quietly
 * spawned a second hearth of its own — which is what it does when it cannot
 * find the first one's lock. This is the test that would not.
 */

interface Health {
  ok: boolean;
  data: { pid: number; root: string } | null;
}

test("the dashboard proxies to the hearth the suite started, for this checkout", async ({
  request,
}, testInfo) => {
  const direct = await request.get(`${HEARTH_URL}${HEALTH_ROUTE}`);
  expect(direct.ok(), "the hearth answers on its own port").toBe(true);
  const hearth = ((await direct.json()) as Health).data;

  const proxied = await request.get(HEALTH_ROUTE);
  expect(proxied.ok(), "the dashboard proxies the control-plane API").toBe(
    true,
  );
  const behindDashboard = ((await proxied.json()) as Health).data;

  // Checked first: two missing pids would otherwise compare equal below.
  expect(typeof hearth?.pid, "the hearth reports its pid").toBe("number");
  expect(
    behindDashboard?.pid,
    "one hearth, not a second one spawned by the dashboard",
  ).toBe(hearth?.pid);

  // The config file's directory is the cwd Playwright gives both servers.
  // (`config.rootDir` is the test directory, not the checkout.)
  const configFile = testInfo.config.configFile;
  expect(configFile, "the suite runs from a config file").toBeDefined();
  expect(rootKey(hearth?.root ?? "")).toBe(rootKey(dirname(configFile ?? "")));
});
