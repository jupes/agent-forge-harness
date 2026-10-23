import baseTeardown from "../e2e/global-teardown";
import { removeRepository } from "./environment";

export default function teardown() {
  baseTeardown();
  removeRepository();
}
