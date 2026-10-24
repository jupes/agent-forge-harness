/** Source entry only; the compiled entry imports the side-effect-free implementation. */
import { isMain } from "../../is-main";
import { runCodingCliFixture } from "./coding-cli-fixture";

if (isMain(import.meta)) await runCodingCliFixture();
