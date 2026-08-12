// Guards for the composer footer on mobile, and for the i18n provider's mount.
//
// The controls row used to be absolutely positioned with `flexWrap: nowrap`, no
// `overflow`, and contents that cannot shrink: .ui-btn sets `white-space: nowrap`
// so a labelled control's min-content is its whole label, and .ui-btn--icon pins
// 44px with `flex-shrink: 0`. Roughly 406px of controls in the 328px available on a
// 360px phone, with the excess unreachable.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * Comments are stripped before scanning. They deliberately name the values they
 * replaced — that is the evidence for the change — and a guard that reads prose as
 * code forces the documentation out to stay green.
 */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const chatInput = codeOnly(readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8"));
const layout = codeOnly(readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8"));
const homePage = codeOnly(readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8"));

test("the mobile controls row wraps instead of overflowing", () => {
  assert.match(chatInput, /flexWrap: "wrap"/);
  // Nothing in the composer may reintroduce a nowrap flex row that cannot scroll.
  assert.doesNotMatch(chatInput, /flexWrap: "nowrap"/);
});

test("the controls row no longer floats over the model selector", () => {
  // It was `position: absolute; right: 0; bottom: 0` inside the column next to the
  // model selector, so opening it hid the control being configured. Both of these
  // literals were unique to that floating box — `max-content` is not checked here
  // because the model dropdown uses it legitimately for its own width.
  assert.doesNotMatch(chatInput, /maxWidth: "calc\(100vw - 32px\)"/);
  assert.doesNotMatch(chatInput, /zIndex: 60/);
  // Instead the grid item takes a row of its own.
  assert.match(chatInput, /gridColumn: "1 \/ -1"/);
});

test("the trigger is unmounted while open, not left invisible", () => {
  assert.match(chatInput, /isMobile && !controlsMenuOpen && \(/);
  assert.doesNotMatch(chatInput, /visibility: controlsMenuOpen \? "hidden" : "visible"/);
});

test("the footer respects safe-area insets", () => {
  // AppShell's top bar accounts for them in nine places; this footer accounted for
  // them in none, so the composer ran under a notch and the home indicator.
  for (const side of ["left", "right", "bottom"]) {
    assert.match(chatInput, new RegExp(`env\\(safe-area-inset-${side}\\)`), `missing inset for ${side}`);
  }
});

test("the send button obeys the tap floor", () => {
  // It is styled inline rather than through .ui-btn, so it never inherited
  // min-height: var(--tap) and computed to about 32px against a 44px minimum.
  const send = chatInput.slice(chatInput.indexOf("onClick={handleSend}"));
  assert.match(send.slice(0, 900), /minHeight: "var\(--tap\)"/);
});

test("I18nProvider is mounted once, in the root layout", () => {
  // Mounting it per-page meant any new route threw "useI18n must be used inside
  // I18nProvider" the first time it rendered a component that reads one.
  assert.match(layout, /<I18nProvider>/);
  assert.doesNotMatch(homePage, /I18nProvider/);
});

test("component tests import i18n by the same specifier the components use", () => {
  // jiti keys its module cache by specifier: "../hooks/useI18n.tsx" and
  // "@/hooks/useI18n" evaluated as two separate modules, so createContext ran
  // twice. The provider filled one context and useI18n read the other, which is
  // what produced 13 of the suite's failures.
  for (const file of ["MessageView.test.mjs", "ChatInput.test.mjs", "MermaidBlock.test.mjs"]) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /jiti\.import\("\.\.\/hooks\/useI18n\.tsx"\)/, `${file} must not import i18n by path`);
    assert.match(source, /jiti\.import\("@\/hooks\/useI18n"\)/, `${file} must import i18n by alias`);
  }
});
