import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("scopes Next.js output file tracing to the pi-web package", async () => {
  const config = await createJiti(import.meta.url).import("../next.config.ts", { default: true });

  // Resolve before comparing. __dirname reaches the config through jiti as a
  // forward-slash path ("F:/explore/pi-hub") while path.resolve() above returns
  // native separators, so comparing the raw strings fails on Windows.
  assert.equal(path.resolve(config.outputFileTracingRoot), projectRoot);
});
