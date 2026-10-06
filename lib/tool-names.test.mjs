import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizeToolNames } = await jiti.import("./tool-names.ts");

test("normalizes known legacy built-in names only", () => {
  assert.deepEqual(
    normalizeToolNames(["Read", "Bash", "read", "myExtensionTool", "constructor", "__proto__"]),
    ["read", "bash", "myExtensionTool", "constructor", "__proto__"],
  );
});

test("preserves omitted defaults and explicit empty disablement", () => {
  assert.equal(normalizeToolNames(undefined), undefined);
  assert.deepEqual(normalizeToolNames([]), []);
});
