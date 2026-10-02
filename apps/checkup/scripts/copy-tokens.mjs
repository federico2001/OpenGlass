// Copies the Clear Channel design tokens from apps/web (their single source) next to the
// built server, where src/server.ts's loadTokens() reads them at runtime.
import { copyFileSync, mkdirSync } from "node:fs";

const from = new URL("../../web/app/tokens.css", import.meta.url);
const to = new URL("../dist/assets/tokens.css", import.meta.url);
mkdirSync(new URL(".", to), { recursive: true });
copyFileSync(from, to);
