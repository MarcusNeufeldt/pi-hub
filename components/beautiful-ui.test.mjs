import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const selection = read("./SelectionActions.tsx");
const loading = read("./LoadingState.tsx");
const approval = read("./ApprovalCard.tsx");
const chatWindow = read("./ChatWindow.tsx");
const css = read("../app/globals.css");

describe("SelectionActions stays inside its container", () => {
  it("requires both ends of the selection to be in the container", () => {
    // commonAncestorContainer alone would accept a selection that starts in a
    // message and ends in the composer, which would then offer to rewrite it.
    assert.match(selection, /container\.contains\(range\.startContainer\)/);
    assert.match(selection, /container\.contains\(range\.endContainer\)/);
  });

  it("is scoped by a caller-supplied container, never the document", () => {
    assert.match(selection, /containerRef: React\.RefObject<HTMLElement \| null>/);
    assert.doesNotMatch(selection, /document\.body\.contains/);
  });

  it("ignores a collapsed or trivially short selection", () => {
    assert.match(selection, /selection\.isCollapsed/);
    assert.match(selection, /MIN_SELECTION_LENGTH/);
  });

  it("listens for scroll in the capture phase", () => {
    // A scroll inside the message list does not bubble to window, so a
    // non-capturing listener would leave the bar floating over stale text.
    assert.match(selection, /addEventListener\("scroll", hide, true\)/);
  });

  it("does not dismiss on a pointerdown inside its own bar", () => {
    // Otherwise the bar would close before the button's click handler ran.
    assert.match(selection, /barRef\.current\?\.contains\(event\.target as Node\)\) return/);
  });

  it("clears the highlight after running an action", () => {
    // Leaving the range selected would re-raise the bar on the next
    // selectionchange, immediately after it was dismissed.
    assert.match(selection, /removeAllRanges\(\)/);
  });

  it("removes every listener it adds", () => {
    const added = [...selection.matchAll(/(?:document|window)\.addEventListener\("([a-z]+)"/g)].map((m) => m[1]);
    const removed = [...selection.matchAll(/(?:document|window)\.removeEventListener\("([a-z]+)"/g)].map((m) => m[1]);
    assert.ok(added.length > 0, "expected listeners");
    for (const event of new Set(added)) {
      assert.ok(removed.includes(event), `"${event}" is added but never removed`);
    }
  });

  it("adds no icon dependency", () => {
    // The upstream component imports ten icons from iconoir-react plus two atoms
    // that are not distributed with it; this app carries no icon package.
    // Asserted against import statements only — the file's own comment names
    // those packages in order to explain that it does not use them.
    const imports = [...selection.matchAll(/^import[\s\S]*?from\s+"([^"]+)";$/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ["react"], `unexpected imports: ${imports.join(", ")}`);
  });
});

describe("LoadingState", () => {
  it("drives the grid from CSS delays, not a JS tick", () => {
    // Nine cells share one keyframe and differ only by animation-delay, so the
    // wavefront costs no per-frame work. The only timer in the file is the
    // once-per-100ms elapsed readout.
    assert.match(loading, /`pixel-on \$\{durationMs\}ms[^`]*\$\{delay\}ms infinite`/);
    assert.doesNotMatch(loading, /requestAnimationFrame/);
    assert.equal((loading.match(/setInterval\(/g) ?? []).length, 1);
  });

  it("takes the turn start time so a remount cannot restart the clock", () => {
    assert.match(loading, /startedAt\?: number \| null/);
    assert.match(loading, /now - \(startedAt \?\? now\)/);
  });

  it("uses tabular figures so the row does not jitter", () => {
    assert.match(loading, /fontVariantNumeric: "tabular-nums"/);
  });

  it("renders without a label", () => {
    // phaseLabel can return null before a phase has a translation.
    assert.match(loading, /label\?: string \| null/);
    assert.match(loading, /\{label && \(/);
  });
});

describe("ApprovalCard", () => {
  it("advances a single-choice question but waits on multi-select", () => {
    assert.match(approval, /question\.kind === "single"/);
    assert.match(approval, /ADVANCE_DELAY_MS/);
    assert.match(approval, /question\.kind === "multiple" && \(/);
  });

  it("survives an empty question list", () => {
    assert.match(approval, /if \(!question\) return null;/);
  });

  it("is data-driven rather than carrying demo content", () => {
    // The upstream component hardcodes its own sample questions.
    assert.match(approval, /questions: ApprovalQuestion\[\]/);
    assert.doesNotMatch(approval, /flavor|gelato|scoop/i);
  });
});

describe("the ports use this app's design system", () => {
  it("references no tokens from the source library's scale", () => {
    for (const source of [selection, loading, approval]) {
      // --ink / --surface / --line / --field do not exist here; classes built on
      // them would render unstyled.
      assert.doesNotMatch(source, /var\(--(ink|surface|line|line-strong|field|canvas|shadow-btn)\b/);
      assert.doesNotMatch(source, /\b(text-ink|bg-surface|border-line|bg-field|bg-canvas|text-accent-ink)\b/);
    }
  });

  it("declares every keyframe the components animate", () => {
    for (const name of ["pixel-on", "shimmer-text", "pop-in", "fade-up"]) {
      assert.ok(css.includes(`@keyframes ${name}`), `missing @keyframes ${name}`);
    }
  });

  it("respects reduced motion", () => {
    const block = css.slice(css.indexOf(".pixel-grid-cell"), css.indexOf(".pixel-grid-cell") + 600);
    assert.match(block, /animation: none/);
    // The timer keeps ticking, so freezing the grid loses no information.
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]{0,400}\.pixel-grid-cell/);
  });
});

describe("Collapse animates to auto height", () => {
  const collapse = read("./ui/Collapse.tsx");
  const messageView = read("./MessageView.tsx");

  it("transitions grid-template-rows rather than max-height", () => {
    // 0fr -> 1fr resolves against real content, so nothing has to guess a height.
    // A max-height ceiling either clips or spends the duration on empty space.
    assert.match(css, /\.ui-collapse\s*\{[\s\S]*?grid-template-rows:\s*0fr/);
    assert.match(css, /\.ui-collapse\.is-open\s*\{\s*\n?\s*grid-template-rows:\s*1fr/);
    assert.match(css, /transition:\s*grid-template-rows[^;]*var\(--ease-expo\)/);
  });

  it("keeps min-height:0 on the inner element", () => {
    // Without it the grid row will not shrink below its content and the panel
    // simply does not move — the failure looks like the transition being ignored.
    assert.match(css, /\.ui-collapse__inner\s*\{[\s\S]*?min-height:\s*0/);
    assert.match(css, /\.ui-collapse__inner\s*\{[\s\S]*?overflow:\s*hidden/);
  });

  it("mounts one frame before flipping the class", () => {
    // Setting mounted and open together starts the element at 1fr with nothing
    // to transition from, and the panel appears instantly.
    assert.match(collapse, /requestAnimationFrame\(\(\) => setActive\(true\)\)/);
    assert.match(collapse, /cancelAnimationFrame/);
  });

  it("does not unmount or hide content while closing", () => {
    // Either would remove the content mid-transition, so the panel would blink
    // out instead of closing.
    assert.doesNotMatch(collapse, /hidden=\{/);
    assert.match(collapse, /const \[mounted, setMounted\] = useState\(open\)/);
  });

  it("switches instantly under reduced motion", () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\n?\s*\.ui-collapse \{ transition: none; \}/);
  });

  it("replaces the instant-snap disclosures on the per-turn surfaces", () => {
    // Thinking blocks and tool output render on essentially every turn.
    assert.match(messageView, /<Collapse open=\{expanded\}>/);
    assert.match(chatWindow, /<Collapse open=\{expanded\}>/);
  });
});

describe("chat wiring", () => {
  it("scopes the selection bar to the message list and disables it mid-turn", () => {
    assert.match(chatWindow, /containerRef=\{scrollContainerRef\}/);
    assert.match(chatWindow, /disabled=\{sessionBusy\}/);
    assert.match(chatWindow, /chatInputRef\?\.current\?\.insertText\(prompt\)/);
  });

  it("gives the loader a stable turn start time", () => {
    assert.match(chatWindow, /setTurnStartedAt\(agentRunning \? Date\.now\(\) : null\)/);
    assert.match(chatWindow, /<LoadingState label=\{phaseLabel\(agentPhase, t\)\} startedAt=\{turnStartedAt\}/);
  });
});
