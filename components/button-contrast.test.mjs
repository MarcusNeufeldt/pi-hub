// Guards the filled-button ink/fill pairing.
//
// `--accent` is a *text* colour. Used as a button background it measures 1.86:1
// against white in dark mode, so every primary action — Confirm, Submit, Select
// directory, Save model, Install skill — had a near-invisible label. The naive fix
// is worse than useless: keeping `--accent` as the background and swapping the ink
// to `--accent-on` gives 10.24:1 dark but drops light to 3.42:1, under the floor.
// Both tokens have to move together.
//
//   ink              on fill              light    dark
//   #fff             --accent             5.43     1.86  <- was
//   --accent-on      --accent             3.42    10.24  <- naive
//   --accent-on      --accent-fill        5.92     8.14  <- is
//   #fff             --danger             6.29     2.77  <- was
//   --danger-on      --danger             6.29     6.89  <- is
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const COMPONENTS = [
  "ChatWindow.tsx", "DirectoryPicker.tsx", "ModelsConfig.tsx", "PluginsConfig.tsx",
  "SessionSidebar.tsx", "SkillsConfig.tsx", "TasksConfig.tsx", "telegram/TelegramSettings.tsx",
];

function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const sources = new Map(
  COMPONENTS.map((name) => [name, codeOnly(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"))]),
);
const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

test("both inks are defined once per theme", () => {
  for (const token of ["--accent-on", "--danger-on", "--accent-fill"]) {
    assert.equal(css.split(`${token}:`).length - 1, 2, `${token} needs a light and a dark value`);
  }
});

test("--accent is never an unconditional button fill", () => {
  // It is a text colour; --accent-fill is the surface counterpart. Every one of the
  // twelve literal uses was a button with a label on it.
  //
  // Conditional fills are deliberately not checked. The toggle tracks in
  // SkillsConfig and PluginsConfig legitimately use `enabled ? "var(--accent)"` as
  // a surface with no text on it, so a generic ban would be asserting something
  // untrue. The white-ink check below is what actually catches a regression here:
  // a new accent button only becomes a contrast bug once it has a light label.
  for (const [name, source] of sources) {
    assert.ok(!source.includes('background: "var(--accent)"'), `${name} uses --accent as a fill`);
  }
});

test("no filled accent or danger button carries white text", () => {
  for (const [name, source] of sources) {
    for (const literal of ['"#fff"', '"#ffffff"', '"white"']) {
      assert.ok(!source.includes(`color: ${literal}`), `${name} still inks a button with ${literal}`);
    }
  }
});

test("every accent-on sits on an accent fill, every danger-on on danger", () => {
  // The pairing is the whole point: either token on the wrong fill reintroduces
  // the failure in one theme or the other.
  for (const [name, source] of sources) {
    const lines = source.split(/\r?\n/);
    lines.forEach((line, i) => {
      const ink = line.match(/color: [^,}]*--(accent|danger)-on/);
      if (!ink) return;
      const wanted = ink[1] === "accent" ? "accent-fill" : "danger";
      let background = null;
      for (let d = 0; d <= 10 && background === null; d++) {
        for (const j of [i - d, i + d]) {
          if (j < 0 || j >= lines.length) continue;
          const found = lines[j].match(/background: ([^,}]+)/);
          if (found) { background = found[1]; break; }
        }
      }
      assert.ok(
        background && background.includes(wanted),
        `${name}:${i + 1} inks with --${ink[1]}-on but its background is ${background}`,
      );
    });
  }
});
