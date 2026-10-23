#!/usr/bin/env bun
/** Source entry for the canonical PR-body validator. Compiled code imports scripts/pr-body directly. */
import { isMain } from "../../../../scripts/is-main";
import {
  REQUIRED_PR_SECTIONS,
  validatePrBody,
} from "../../../../scripts/pr-body";

if (isMain(import.meta)) {
  const path = process.argv[2];
  try {
    const body =
      !path || path === "-"
        ? await Bun.stdin.text()
        : await Bun.file(path).text();
    const result = validatePrBody(body);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          data: { present: [], missing: [...REQUIRED_PR_SECTIONS], empty: [] },
          error: `could not read PR body${path ? ` from "${path}"` : ""}: ${(err as Error).message}`,
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
}
