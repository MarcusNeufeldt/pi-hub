/**
 * Locale hygiene.
 *
 * Two failure modes this catches, both of which have shipped before:
 *   - a key added to en.ts and forgotten in zh-CN.ts, which renders the raw key
 *   - a key declared twice in one file, where the later value silently wins and
 *     the earlier one looks correct in review (this is how a sidebar toggle lost
 *     its accessible name)
 *
 * The duplicate check reads the source text rather than the parsed object,
 * because an object literal dedupes its own keys before any test can see them.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { enLocale } from "./en.ts";
import { zhCNLocale } from "./zh-CN.ts";

const LOCALES = [
  ["en", enLocale, "en.ts"],
  ["zh-CN", zhCNLocale, "zh-CN.ts"],
];

function declaredKeys(file) {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  return [...source.matchAll(/^\s*"([^"]+)":/gm)].map((match) => match[1]);
}

test("no locale declares the same key twice", () => {
  for (const [name, , file] of LOCALES) {
    const keys = declaredKeys(file);
    const seen = new Set();
    const duplicates = [];
    for (const key of keys) {
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    assert.deepEqual(duplicates, [], `${name} declares duplicate keys: ${duplicates.join(", ")}`);
  }
});

test("every locale carries the same key set", () => {
  const [, base] = LOCALES[0];
  const baseKeys = Object.keys(base.messages).sort();
  for (const [name, locale] of LOCALES.slice(1)) {
    const keys = Object.keys(locale.messages).sort();
    const missing = baseKeys.filter((key) => !keys.includes(key));
    const extra = keys.filter((key) => !baseKeys.includes(key));
    assert.deepEqual(missing, [], `${name} is missing: ${missing.join(", ")}`);
    assert.deepEqual(extra, [], `${name} has keys en lacks: ${extra.join(", ")}`);
  }
});

test("no message is left empty", () => {
  for (const [name, locale] of LOCALES) {
    for (const [key, value] of Object.entries(locale.messages)) {
      assert.ok(String(value).trim().length > 0, `${name}.${key} is empty`);
    }
  }
});

test("no locale uses a placeholder its callers never supply", () => {
  /*
   * One-directional on purpose. Omitting a placeholder is legitimate
   * localisation — en needs "{count} file{countSuffix}" to pluralise, while
   * zh-CN has no plural suffix and correctly drops it. Introducing one en does
   * not have is always a bug: nothing substitutes it, so it renders literally
   * as "{foo}" in the UI.
   */
  const placeholders = (value) =>
    new Set([...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]));
  const [, base] = LOCALES[0];
  for (const [name, locale] of LOCALES.slice(1)) {
    for (const [key, value] of Object.entries(locale.messages)) {
      const supplied = placeholders(base.messages[key] ?? "");
      const unknown = [...placeholders(value)].filter((token) => !supplied.has(token));
      assert.deepEqual(unknown, [], `${name}.${key} uses unsupplied placeholder(s): ${unknown.join(", ")}`);
    }
  }
});
