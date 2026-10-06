import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("Pi host packages use the same exact version", () => {
  const version = manifest.dependencies["@earendil-works/pi-coding-agent"];
  assert.match(version, /^\d+\.\d+\.\d+$/);
  for (const name of ["pi-agent-core", "pi-ai", "pi-tui"]) {
    assert.equal(manifest.dependencies[`@earendil-works/${name}`], version);
  }
});

test("detached workers can load chord and chord/context from the embedded Pi host", async () => {
  // Resolve from Hub's SDK, not the global CLI or the extension's npm tree.
  const sdkEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const hostRequire = createRequire(sdkEntry);
  const chordManifest = hostRequire.resolve("@earendil-works/chord/package.json");
  const chord = JSON.parse(readFileSync(chordManifest, "utf8"));
  for (const subpath of [".", "./context"]) {
    const entry = chord.exports[subpath].import;
    assert.equal(typeof entry, "string");
    await import(pathToFileURL(resolve(dirname(chordManifest), entry)).href);
  }
});
