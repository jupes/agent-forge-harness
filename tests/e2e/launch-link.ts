import { tokenPath } from "../../scripts/hearth/home";
import { launchUrl, requestLaunch } from "../../scripts/hearth/launch";
import { LAUNCH_KEY } from "../../scripts/hearth/paths";
import { readToken } from "../../scripts/hearth/token";
import { DASHBOARD_URL, HEARTH_HOME, HEARTH_PORT } from "./servers";

/**
 * Launch links for the suite's dashboard (`x1gs.3.31`), minted as the
 * launcher and `bun run dashboard:open` mint them: with the operator token
 * read from the suite's hearth's token file, from the hearth over its own
 * loopback socket. A page gets the operator token only once it has been
 * opened from one: global setup opens one and saves the session it gave
 * (`STORAGE_STATE`), which every spec's page starts with.
 */

/**
 * The suite's hearth's operator token, from its token file. The hearth's root
 * is the checkout, the directory the runner and its servers run in.
 */
export function hearthToken(): string {
  const token = readToken(tokenPath(HEARTH_HOME, process.cwd()));
  if (token === null)
    throw new Error(
      `The suite's hearth has no token file in ${HEARTH_HOME}: it did not start, or it is not the one this run started`,
    );
  return token;
}

/**
 * A fresh launch link for the dashboard: `/#launch=<secret>`, or with a route
 * (`/timeline?bead=x`), `/index.html#/timeline?bead=x&launch=<secret>`.
 */
export async function launchLink(route?: string): Promise<string> {
  const { secret } = await requestLaunch({
    port: HEARTH_PORT,
    token: hearthToken(),
    surface: "cli",
  });
  if (route === undefined) return launchUrl(`${DASHBOARD_URL}/`, secret);
  const joiner = route.includes("?") ? "&" : "?";
  return `${DASHBOARD_URL}/index.html#${route}${joiner}${LAUNCH_KEY}=${secret}`;
}
