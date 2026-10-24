import { runInteractiveBootstrap } from "./interactive-bootstrap";

// Source-only trusted entry. The compiled hearth imports the side-effect-free implementation.
await runInteractiveBootstrap();
