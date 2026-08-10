import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Guards for the split-pane invariants that fail *silently*: none of these
 * produce an error when broken, they just quietly show one pane's data under
 * another pane's name, or lose a performance property with nothing to notice.
 */
const source = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

describe("pane state is scoped per pane", () => {
  it("keys the subagent counter by pane", () => {
    // A single shared counter made returning to a pane that already had workers
    // running look like a fresh spawn, popping the right panel open.
    assert.match(source, /prevRunningSubagentsRef = useRef<Record<string, number>>\(\{\}\)/);
    assert.match(source, /prevRunningSubagentsRef\.current\[paneId\] = running/);
  });

  it("keys the turn-changes signature by pane", () => {
    assert.match(source, /turnChangesSigRef = useRef<Record<string, string>>\(\{\}\)/);
    assert.match(source, /turnChangesSigRef\.current\[paneId\] = sig/);
  });

  it("records bookkeeping for unfocused panes before the focus gate", () => {
    // The write must happen before the early return, or an unfocused pane's
    // count never updates and the comparison is against a stale value.
    const block = source.slice(
      source.indexOf("const handleSubagentsChange"),
      source.indexOf("const turnChangesSigRef"),
    );
    const recordAt = block.indexOf("prevRunningSubagentsRef.current[paneId] = running");
    const gateAt = block.indexOf("if (paneId !== focusedPaneIdRef.current) return");
    assert.ok(recordAt > 0 && gateAt > 0, "expected both the record and the focus gate");
    assert.ok(recordAt < gateAt, "the per-pane count must be recorded before the focus gate");
  });

  it("holds branch state per pane rather than app-wide", () => {
    assert.match(source, /branchTree: SessionTreeNode\[\]/);
    assert.match(source, /branchLeafChangeFnRef = useRef<Record<string, \(leafId: string \| null\) => void>>/);
    assert.doesNotMatch(source, /const \[branchTree, setBranchTree\]/);
  });

  it("drops a closed pane's bookkeeping", () => {
    assert.match(source, /delete prevRunningSubagentsRef\.current\[paneId\]/);
    assert.match(source, /delete turnChangesSigRef\.current\[paneId\]/);
    assert.match(source, /delete branchLeafChangeFnRef\.current\[paneId\]/);
  });
});

describe("session writes target the reporting pane", () => {
  it("gives handleSessionCreated and handleSessionForked a pane id", () => {
    // Writing through the focused-pane setters dropped a new session into
    // whichever pane the user clicked during the round-trip.
    assert.match(source, /const handleSessionCreated = useCallback\(\(paneId: string, session: SessionInfo\)/);
    assert.match(source, /const handleSessionForked = useCallback\(\(paneId: string, newSessionId: string\)/);
  });

  it("lets only the focused pane rewrite the URL", () => {
    // The query string names a single session, so a background pane must not
    // navigate the browser.
    const matches = source.match(/if \(paneId === focusedPaneIdRef\.current\) \{\s*\n\s*router\.replace/g);
    assert.equal(matches?.length, 2, "expected the guard in both created and forked");
  });

  it("hydrates through the pane rather than the selection", () => {
    assert.match(source, /const hydratePaneSession = useCallback\(\(paneId: string, sessionId: string\)/);
    assert.doesNotMatch(source, /hydrateSelectedSession/);
  });
});

describe("per-pane callbacks stay referentially stable", () => {
  it("memoises them keyed on pane ids, not pane objects", () => {
    // ChatWindow clears its stats on unmount keyed on the callback identity, so
    // an unstable callback loops: cleanup -> null stats -> render -> new identity.
    // Keying on pane objects would rebuild on every session change and blink the
    // top bar to null and back on each message.
    assert.match(source, /const paneIdsKey = panes\.map\(\(pane\) => pane\.id\)\.join\(","\)/);
    const memoStart = source.indexOf("const paneCallbacks = useMemo(");
    assert.ok(memoStart > 0, "expected a memoised callback map");
    const memoBlock = source.slice(memoStart, source.indexOf("const handleInitialRestoreDone"));
    assert.match(memoBlock, /for \(const paneId of paneIdsKey\.split\(","\)\)/);
    assert.doesNotMatch(memoBlock, /for \(const pane of panes\)/);
  });

  it("does not hand ChatWindow an inline closure for the reporting callbacks", () => {
    const renderBlock = source.slice(
      source.indexOf("<PaneChatWindow"),
      source.indexOf("initialCwdStatus === \"validating\""),
    );
    for (const prop of [
      "onSessionStatsChange",
      "onContextUsageChange",
      "onSubagentsChange",
      "onTurnChangesChange",
      "onSessionCreated",
      "onSessionForked",
    ]) {
      assert.match(
        renderBlock,
        new RegExp(`${prop}=\\{callbacks\\?\\.${prop}\\}`),
        `${prop} must come from the memoised map, not a fresh closure`,
      );
    }
  });
});

describe("pane header", () => {
  const tree = readFileSync(new URL("./ChatPaneTree.tsx", import.meta.url), "utf8");

  it("shows the header only when the area is split", () => {
    // With one pane the session is already named in the sidebar and top bar, and
    // the single-pane view must stay visually identical to before panes existed.
    assert.match(tree, /\{split && \(\s*\n\s*<div className="chat-pane__header">/);
  });

  it("carries running and unread state to assistive tech, not just as colour", () => {
    assert.match(tree, /role="img"/);
    assert.match(tree, /aria-label=\{meta\?\.running \? labels\.running : meta\?\.unread \? labels\.unread : ""\}/);
  });

  it("never badges the focused pane as unread", () => {
    // Focusing a pane is what clears its unread marker, so a badge there is
    // stale by definition.
    assert.match(source, /unread: sessionId !== null && unread\.has\(sessionId\) && pane\.id !== focusedPaneId/);
  });

  it("falls back from session name to directory name", () => {
    assert.match(source, /title: name \|\| \(cwd \? getFileName\(cwd\) \|\| cwd : translate\("pane\.untitled"\)\)/);
  });
});

describe("running state has a single subscriber", () => {
  const sidebar = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

  it("reports the sets upward instead of the shell opening a second stream", () => {
    // The sidebar stays mounted even when collapsed, so its subscription is the
    // one source. A second EventSource in AppShell would be a permanently-held
    // connection against a ~6-per-origin budget.
    assert.match(sidebar, /onRunningSessionsChange\?\.\(/);
    assert.match(sidebar, /onUnreadSessionsChange\?\.\(/);
    assert.doesNotMatch(source, /new EventSource\(/);
  });

  it("keys the upward report on a sorted join, not the Set identity", () => {
    // The Sets are rebuilt on unrelated renders; reporting on identity would fire
    // the effect constantly.
    assert.match(sidebar, /const runningIdsKey = \[\.\.\.runningSessionIds\]\.sort\(\)\.join\(","\)/);
    assert.match(sidebar, /const unreadIdsKey = \[\.\.\.unreadSessionIds\]\.sort\(\)\.join\(","\)/);
  });
});

describe("pane rendering", () => {
  it("memoises the pane ChatWindow", () => {
    // One pane streaming otherwise re-renders every other pane's transcript on
    // every token.
    assert.match(source, /const PaneChatWindow = memo\(ChatWindow\)/);
    assert.match(source, /<PaneChatWindow/);
  });

  it("gives each pane its own remount key", () => {
    assert.match(source, /key=\{`\$\{pane\.id\}:\$\{pane\.remountKey\}`\}/);
  });

  it("lends the shared chat input only to the focused pane", () => {
    assert.match(source, /chatInputRef=\{pane\.id === focusedPaneId \? chatInputRef : undefined\}/);
  });
});
