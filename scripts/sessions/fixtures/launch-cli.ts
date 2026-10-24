/** Hermetic pipe recorder. It neither resolves files nor contacts a provider. */
import { isMain } from "../../is-main";

if (isMain(import.meta)) {
  const stdin = await Bun.stdin.text();
  console.log(
    JSON.stringify({
      argv: process.argv.slice(2),
      stdin,
      secretPresent: Object.hasOwn(process.env, "FORBIDDEN_SESSION_SECRET"),
    }),
  );
}
