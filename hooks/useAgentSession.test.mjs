import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const chatWindowSource = (await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const cssSource = (await readFile(new URL("../app/globals.css", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

const onErrorSource = source.slice(source.indexOf("es.onerror = () => {"), source.indexOf("eventConnectionAttemptRef.current = { source: es"));

test("re-establishes a dead event stream regardless of whether the agent is running", () => {
  // The bug: reconnect used to require (agentRunningRef || graceActive), so a
  // stream dropped while the session sat idle stayed dead forever -- no retry, no
  // UI hint. Browsers drop SSE routinely (tab backgrounded, screen locked, laptop
  // slept, phone changed network), which is the "left it open and it stopped
  // updating" report. Being open in another tab or on another device is NOT the
  // cause: the server fans out to a listener array, verified separately.
  assert.doesNotMatch(
    onErrorSource,
    /agentRunningRef\.current \|\| eventStreamGraceActiveRef\.current/,
    "reconnect must not be gated on the agent running or a grace window",
  );
  // It reconnects while this session is still the open one, and not otherwise.
  assert.match(onErrorSource, /if \(sessionIdRef\.current !== sid\) return;/);
  assert.match(onErrorSource, /void connectEvents\(sid\);/);
});

test("bounds event stream reconnects so a dead session cannot be retried forever", () => {
  // A session that is genuinely gone answers 404 for as long as the tab is open.
  assert.match(source, /const EVENT_STREAM_MAX_RECONNECT_ATTEMPTS = \d+;/);
  assert.match(onErrorSource, /if \(attempt >= EVENT_STREAM_MAX_RECONNECT_ATTEMPTS\) return;/);
  // Exponential, with a ceiling so the delay cannot grow without bound.
  assert.match(onErrorSource, /Math\.min\(\s*EVENT_STREAM_RECONNECT_BASE_MS \* 2 \*\* attempt,\s*EVENT_STREAM_RECONNECT_MAX_MS,?\s*\)/);
  assert.doesNotMatch(onErrorSource, /\}, 1000\);/, "the retry delay must come from the backoff, not a fixed 1s");
});

test("resets the reconnect budget on a live stream and per session, never per attempt", () => {
  // Reset on success, so a later unrelated outage starts from the shortest delay.
  const onMessageSource = source.slice(source.indexOf("es.onmessage = (e) => {"), source.indexOf("es.onerror = () => {"));
  assert.match(onMessageSource, /eventReconnectAttemptsRef\.current = 0;/);
  // Reset when the session changes, but NOT on every connect attempt -- resetting
  // per attempt would make the cap unreachable and restore the infinite retry.
  const connectSource = source.slice(source.indexOf("const connectEvents = useCallback"), source.indexOf("es.onmessage = (e) => {"));
  assert.match(connectSource, /if \(eventReconnectSessionIdRef\.current !== sid\) \{/);
  assert.match(connectSource, /eventReconnectAttemptsRef\.current = 0;/);
});

test("abandons a superseded socket instead of reconnecting it", () => {
  // closeEvents() or a newer connect replaced the current EventSource; retrying
  // this one would race a live connection.
  assert.match(onErrorSource, /if \(eventSourceRef\.current !== es\) return;/);
  // And a recoverable CONNECTING error is left to the browser's own retry.
  assert.match(onErrorSource, /if \(es\.readyState !== EventSource\.CLOSED\) \{\s*\n[\s\S]*?return;\s*\n\s*\}/);
});

test("keeps the session event stream open through the idle grace window", () => {
  const finishSource = source.slice(
    source.indexOf("const finishPromptWithoutStream"),
    source.indexOf("const waitForPromptSettlement"),
  );
  const graceSource = source.slice(
    source.indexOf("const scheduleEventStreamClose"),
    source.indexOf("const finishPromptWithoutStream"),
  );
  const agentEndSource = source.slice(
    source.indexOf('case "agent_end"'),
    source.indexOf('case "agent_settled"'),
  );
  const agentStartSource = source.slice(
    source.indexOf('case "agent_start"'),
    source.indexOf('case "agent_end"'),
  );
  const agentSettledSource = source.slice(
    source.indexOf('case "agent_settled"'),
    source.indexOf('case "prompt_done"'),
  );
  const promptDoneSource = source.slice(
    source.indexOf('case "prompt_done"'),
    source.indexOf('case "prompt_error"'),
  );
  const sendSource = source.slice(
    source.indexOf("  const handleSend = useCallback"),
    source.indexOf("  const executeBash = useCallback"),
  );

  assert.match(source, /const EVENT_STREAM_IDLE_GRACE_MS = 30_000/);
  assert.match(graceSource, /setTimeout\(\(\) => void checkServerIdle\(\), EVENT_STREAM_IDLE_GRACE_MS\)/);
  assert.match(graceSource, /fetch\(`\/api\/agent\/\$\{encodeURIComponent\(sid\)\}`\)/);
  assert.match(graceSource, /closeEvents\(\)/);
  assert.match(graceSource, /subagentsRunningRef\.current\s*\|\| Date\.now\(\) < subagentWakeGraceUntilRef\.current/);
  assert.match(graceSource, /setTimeout\([\s\S]*?checkServerIdle\(\)[\s\S]*?PROMPT_SETTLE_POLL_MS/);
  assert.match(source, /const subagentWakeGraceUntilRef = useRef\(0\)/);
  assert.match(source, /subagentWakeGraceUntilRef\.current = Date\.now\(\) \+ EVENT_STREAM_IDLE_GRACE_MS/);
  assert.match(finishSource, /scheduleEventStreamClose\(sid\)/);
  assert.doesNotMatch(finishSource, /closeEvents\(\)/);
  assert.doesNotMatch(agentEndSource, /closeEvents\(\)/);
  assert.match(agentStartSource, /cancelEventStreamGrace\(\)/);
  assert.match(agentSettledSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(agentSettledSource, /onAgentEnd\?\.\(\)/);
  assert.match(promptDoneSource, /notifyPromptStage\(runId\)/);
  assert.match(promptDoneSource, /scheduleEventStreamClose\(sid\)/);
  assert.match(sendSource, /if \(promptRequestStarted && sentSessionId\) \{[\s\S]*?waitForPromptSettlement/);
  assert.match(sendSource, /if \(promptRequestStarted && sentSessionId\) \{[\s\S]*?return;[\s\S]*?\}[\s\S]*?closeEvents\(\)/);
});

test("builds a durable subagent activity timeline and separate final result", () => {
  const pollingSource = source.slice(
    source.indexOf("// Detached runs publish bounded live snapshots"),
    source.indexOf("const eventSourceRef"),
  );

  assert.match(source, /events\?: SubagentTimelineEvent\[\]/);
  assert.match(source, /finalOutput\?: string/);
  assert.match(source, /function mergeSubagentEvents/);
  assert.match(source, /function omitDuplicatedFinalNarration/);
  assert.match(source, /events: omitDuplicatedFinalNarration\(mergedEvents, finalOutput\)/);
  assert.match(source, /function mergeRehydratedSubagents/);
  assert.match(source, /setSubagents\(\(previous\) => mergeRehydratedSubagents/);
  assert.match(pollingSource, /cursors: JSON\.stringify\(cursors\)/);
  assert.match(pollingSource, /needsArtifactTimeline/);
  assert.match(pollingSource, /query\.set\("artifacts"/);
  assert.match(pollingSource, /status\.piHub\?\.children/);
  assert.match(pollingSource, /filter\(\(event\) => !event\.id\.startsWith\("snapshot-"\)\)/);
  assert.match(pollingSource, /const mergedEvents = mergeSubagentEvents\(/);
  assert.match(pollingSource, /timelineCompletePolls:/);
  assert.match(pollingSource, /view\.events\.length === 0/);
  assert.match(pollingSource, /existing\s*&&\s*existing\.timelineSource === view\.timelineSource/);
  assert.doesNotMatch(pollingSource, /existing\?\.timelineSource === view\.timelineSource/);
  assert.match(pollingSource, /const finalOutput = view\.finalOutput \?\? existing\?\.finalOutput/);
  assert.match(source, /const finalOutput = typeof r\.finalOutput === "string"/);
  assert.match(source, /transcriptPath: transcriptPath \?\? existing\?\.transcriptPath/);
  assert.match(source, /sessionFile: sessionFile \?\? existing\?\.sessionFile/);
  assert.match(pollingSource, /setInterval\(\(\) => void poll\(\), 1_500\)/);
});

test("reuses an open event stream and hides an empty agent phase", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureEventsConnected"),
    source.indexOf("const respondToExtensionUi"),
  );

  assert.match(ensureSource, /eventSourceSessionIdRef\.current === sid/);
  assert.match(ensureSource, /current\.readyState === EventSource\.OPEN/);
  assert.match(ensureSource, /attempt\?\.source === current && attempt\.pending/);
  assert.match(chatWindowSource, /agentRunning && !streamState\.streamingMessage && agentPhase/);
  assert.match(chatWindowSource, /return null;/);
});

test("plays the enabled sound once for each extension dialog", () => {
  assert.match(chatWindowSource, /soundedExtensionDialogIdRef = useRef<string \| null>\(null\)/);
  assert.match(
    chatWindowSource,
    /soundedExtensionDialogIdRef\.current === extensionDialog\.id/,
  );
  assert.match(chatWindowSource, /soundedExtensionDialogIdRef\.current = extensionDialog\.id/);
  assert.match(chatWindowSource, /playDoneSoundRef\.current\(\)/);
});

test("keeps live following cancellable when the user scrolls away from the tail", () => {
  const streamUpdateSource = source.slice(
    source.indexOf('case "message_start"'),
    source.indexOf('case "message_end"'),
  );
  const scrollHandlerSource = source.slice(
    source.indexOf("const handleScrollPositionChange"),
    source.indexOf("// Load session on mount"),
  );

  assert.match(source, /const liveFollowFrameRef = useRef<number \| null>\(null\)/);
  assert.match(streamUpdateSource, /liveFollowFrameRef\.current === null/);
  assert.match(streamUpdateSource, /requestAnimationFrame\(\(\) => \{[\s\S]*?liveFollowFrameRef\.current = null;[\s\S]*?if \(isNearBottomRef\.current\) scrollToBottom\("auto"\)/);
  assert.match(scrollHandlerSource, /cancelAnimationFrame\(liveFollowFrameRef\.current\)/);
});

test("keeps a newly sent user message at the top while its response starts", () => {
  const streamUpdateSource = source.slice(
    source.indexOf('case "message_start"'),
    source.indexOf('case "message_end"'),
  );
  const userScrollSource = source.slice(
    source.indexOf("const scrollUserMsgToTop"),
    source.indexOf("const markUserScrollIntent"),
  );
  const scrollEffectSource = source.slice(
    source.indexOf("useLayoutEffect(() => {\n    if (messages.length > 0)"),
    source.indexOf("// Load model list"),
  );

  assert.match(streamUpdateSource, /!pendingScrollToUserRef\.current && isNearBottomRef\.current/);
  assert.match(source, /const \[promptAnchorActive, setPromptAnchorActive\] = useState\(false\)/);
  assert.match(source, /pendingScrollToUserRef\.current = true;\s*setPromptAnchorActive\(true\)/);
  assert.match(userScrollSource, /const targetTop = Math\.min\(Math\.max\(0, elAbsTop - 16\), maxScrollTop\)/);
  assert.match(userScrollSource, /cancelAnimationFrame\(liveFollowFrameRef\.current\)/);
  assert.match(userScrollSource, /isNearBottomRef\.current = targetTop >= maxScrollTop - SCROLL_BOTTOM_THRESHOLD/);
  assert.match(userScrollSource, /container\.scrollTo\(\{ top: targetTop, behavior: "smooth" \}\)/);
  assert.match(scrollEffectSource, /pendingScrollToUserRef\.current = false;[\s\S]*?scrollUserMsgToTop\(\)/);
  assert.match(chatWindowSource, /const maxScrollTopWithoutAnchor = Math\.max\([\s\S]*?container\.scrollHeight - promptAnchorSpacerHeightRef\.current - container\.clientHeight/);
  assert.match(chatWindowSource, /const nextPromptAnchorSpacerHeight = Math\.max\([\s\S]*?Math\.ceil\(targetTop - maxScrollTopWithoutAnchor\)/);
  assert.match(chatWindowSource, /<div aria-hidden="true" style=\{\{ height: promptAnchorSpacerHeight \}\} \/>/);
});

test("sizes the message tail from the rendered bottom composer", () => {
  assert.match(chatWindowSource, /const bottomComposerRef = useRef<HTMLDivElement \| null>\(null\)/);
  assert.match(chatWindowSource, /useLayoutEffect\(\(\) => \{/);
  assert.match(chatWindowSource, /new ResizeObserver\(updateBottomComposerHeight\)/);
  assert.match(chatWindowSource, /bottomComposerScrollFrameRef = useRef<number \| null>\(null\)/);
  assert.match(chatWindowSource, /distanceFromBottom <= Math\.abs\(nextHeight - previousHeight\) \+ 1/);
  assert.match(chatWindowSource, /scrollToBottom\("auto"\)/);
  // The wrapper carries the measured ref and must establish a positioning
  // context, since the dock's scrim is absolutely positioned against it. That
  // moved from Tailwind's "relative" to .composer-dock, so assert the class is
  // applied AND that it actually sets position: relative — otherwise the scrim
  // would escape and the wrapper's role would be silently weakened.
  assert.match(chatWindowSource, /<div ref=\{bottomComposerRef\} className="composer-dock">/);
  assert.match(cssSource, /\.composer-dock \{[\s\S]*?position: relative;/);
  assert.match(chatWindowSource, /height: bottomComposerHeight/);
});
