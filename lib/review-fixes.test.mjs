import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { toClientAgentEvent } from "./agent-event-wire.ts";

// Run the actual small source callbacks with fake I/O, without starting Pi,
// opening the user's database, or mounting a live browser session.
function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}
function between(text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `source boundary: ${start}`);
  return text.slice(a, b);
}
function evaluate(text, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(code, { exports, console, ...globals });
  return exports;
}
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
const hook = source("../hooks/useAgentSession.ts");
function callback(name, next, globals) {
  return evaluate(`${between(hook, `const ${name} = useCallback`, `const ${next} = useCallback`)}\nexports.fn = ${name};`, {
    useCallback: (fn) => fn, ...globals,
  }).fn;
}

test("SSE subscribes before readiness, closes on destruction and releases cancelled readers", async () => {
  let live = null, waiting = null;
  const timers = new Set();
  function wrapper() {
    const events = new Set(), destroys = new Set();
    return {
      isAlive: () => true,
      onEvent(fn) { events.add(fn); return () => events.delete(fn); },
      onDestroy(fn) { destroys.add(fn); return () => destroys.delete(fn); },
      emit(event) { for (const fn of events) fn(event); },
      destroy() { for (const fn of destroys) fn(); },
      count: () => events.size + destroys.size,
    };
  }
  const { GET } = evaluate(source("../app/api/agent/[id]/events/route.ts"), {
    Request, Response, ReadableStream, TextEncoder,
    setInterval(fn) { timers.add(fn); return fn; },
    clearInterval(fn) { timers.delete(fn); },
    require: () => ({
      toClientAgentEvent,
      getRpcSession: () => live,
      subscribeRpcSessionAvailability(id, fn) { waiting = fn; return () => { waiting = null; }; },
    }),
  });
  const request = () => new Request("http://test/api/agent/s/events");
  const params = { params: Promise.resolve({ id: "s" }) };
  const response = await GET(request(), params);
  assert.equal(typeof waiting, "function", "availability listener exists before headers are usable");
  live = wrapper();
  waiting(live);
  live.emit({ type: "prompt_done" });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  await reader.read(); // padded prelude
  assert.match(decoder.decode((await reader.read()).value), /connected/);
  assert.match(decoder.decode((await reader.read()).value), /prompt_done/);
  live.destroy();
  assert.equal((await reader.read()).done, true);
  assert.equal(timers.size, 0);
  assert.equal(live.count(), 0);

  live = wrapper();
  const replacement = await GET(request(), params);
  assert.equal(live.count(), 2, "new stream binds the replacement wrapper");
  await replacement.body.cancel();
  assert.equal(live.count(), 0);
  assert.equal(timers.size, 0);
  const aborted = new AbortController();
  aborted.abort();
  const closed = await GET(new Request("http://test", { signal: aborted.signal }), params);
  assert.equal(await closed.text(), "");
  assert.equal(timers.size, 0);
});

test("file responses sandbox SVG on full/range requests and reject text-only outside-root grants", async () => {
  const fileSource = source("../app/api/files/[...path]/route.ts");
  const stream = between(fileSource, "function streamFile(", "function escapeHtml(");
  let allowed = false, canonical = false, reads = 0;
  const { GET, serve } = evaluate(`${stream}\n${fileSource.slice(fileSource.indexOf("export async function GET("))}\nexports.serve = streamFile;`, {
    Response,
    NextResponse: { json: (body, init) => Response.json(body, init) },
    filePathFromSegments: () => "/outside/secret",
    parseFileRequestType: (type) => type,
    getAllowedFileRoots: async () => ["/workspace"],
    isFilePathAllowed: () => allowed,
    isExistingFilePathAllowed: () => canonical,
    isFilePathReferencedBySession: async () => true, // text alone must not grant access
    fs: { statSync: () => ({ size: 10, isFile: () => true }) },
    getImageMime: () => "image/png",
    IMAGE_PREVIEW_MAX_BYTES: 100,
    getContentDisposition: (path, download) => download ? "attachment" : "inline",
    createFileBodyStream: () => { reads++; return "image"; },
  });
  for (const range of [null, "bytes=0-3", "bytes=999-"]) {
    const response = serve("drawing.svg", { size: 10 }, "image/svg+xml", range);
    assert.equal(response.headers.get("Content-Disposition"), "attachment");
    assert.match(response.headers.get("Content-Security-Policy"), /sandbox/);
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  }
  reads = 0;
  const request = { nextUrl: new URL("http://test/api/files/outside?type=read&sessionId=s"), headers: new Headers() };
  const params = { params: Promise.resolve({ path: ["outside"] }) };
  assert.equal((await GET(request, params)).status, 403);
  allowed = true; // lexical root matches, but the canonical path escapes
  assert.equal((await GET(request, params)).status, 403);
  assert.equal(reads, 0);
  canonical = true;
  const image = await GET(request, params);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("Content-Disposition"), "inline");
  assert.equal(reads, 1);
});

test("legacy tool aliases resolve against the lowercase registry without disabling extensions", () => {
  const rpc = source("./rpc-manager.ts");
  const normalize = evaluate(source("./tool-names.ts")).normalizeToolNames;
  const policy = source("./runtime-tool-policy.ts");
  const { toolsForPreset } = evaluate(policy.slice(policy.indexOf("export function toolsForPreset")));
  const { select } = evaluate(`${between(rpc, "function withExtensionTools(", "// ============================================================================")}\nexports.select = withExtensionTools;`, {
    normalizeToolNames: normalize, toolsForPreset,
  });
  const names = ["read", "bash", "write", "extension_tool"];
  const session = { getAllTools: () => names.map((name) => ({ name })), getActiveToolNames: () => names };
  assert.equal(select(session, ["Read", "Bash"]).join(","), "read,bash,extension_tool");
  assert.equal(select(session, []).length, 0);
});

test("path lookup waits for a new generation even when invalidation preceded the lookup", async () => {
  const text = source("./session-reader.ts");
  const scans = [], state = {};
  const api = evaluate(
    between(text, "function startSessionListRefresh()", "export async function listAllSessions()") +
    between(text, "export async function refreshSessionListForPathLookup(", "export async function resolveSessionPath(") +
    "exports.start = startSessionListRefresh;", {
      globalThis: state,
      loadAllSessions() { const scan = deferred(); scans.push(scan); return scan.promise; },
    },
  );
  const old = api.start();
  state.__piSessionListGeneration = 1;
  let finished = false;
  const lookup = api.refreshSessionListForPathLookup().then(() => { finished = true; });
  scans[0].resolve([]);
  await old;
  await new Promise(setImmediate);
  assert.equal(scans.length, 2);
  assert.equal(finished, false);
  scans[1].resolve(["new session"]);
  await lookup;
  assert.equal(finished, true);
  assert.equal(state.__piSessionListCache.data[0], "new session");
});

test("branch navigation serializes commands and does not expose a mismatched composer after failure", async () => {
  const command = deferred(), events = [];
  const pending = { current: false };
  let failLoad = false;
  const navigate = callback("queueNavigation", "loadTools", {
    navigationPendingRef: pending, agentRunningRef: { current: false }, bashRunningRef: { current: false },
    isCompacting: false, contextRequestRef: { current: 0 }, sessionIdRef: { current: "s" },
    setNavigationPending: (value) => events.push(["pending", value]),
    sendAgentCommand: async (sid, cmd) => { events.push(["command", cmd.targetId]); return command.promise; },
    loadContext: async (sid, leaf) => { events.push(["context", leaf]); return !failLoad; },
    setActiveLeafId: (leaf) => events.push(["leaf", leaf]),
    setError: (error) => events.push(["error", error]),
  });
  const first = navigate("s", "a");
  assert.equal(pending.current, true);
  assert.equal(await navigate("s", "b"), false);
  assert.equal(events.some(([event]) => event === "context"), false);
  command.resolve({ cancelled: false });
  assert.equal(await first, true);
  assert.deepEqual(events.filter(([event]) => event === "leaf"), [["leaf", "a"]]);
  assert.equal(pending.current, false);
  failLoad = true;
  await assert.rejects(navigate("s", "b"), /Reload before sending/);
  assert.ok(events.some(([event, error]) => event === "error" && /Reload before sending/.test(error)));
  assert.deepEqual(events.filter(([event]) => event === "leaf"), [["leaf", "a"]]);
});

test("late compacted history cannot prepend into a different branch", async () => {
  const response = deferred(), generation = { current: 1 }, messages = [];
  const load = callback("loadEarlierHistory", "loadContext", {
    contextRequestRef: generation, earlierHistoryKeyRef: { current: null }, sessionIdRef: { current: "s" },
    URLSearchParams, fetch: () => response.promise, setContextStartIndex() {}, setEntryIds() {},
    setMessages: (update) => messages.push(update([])),
  });
  const pending = load("s", "a", { role: "custom", customType: "compaction" });
  generation.current++;
  response.resolve({ ok: true, json: async () => ({ messages: ["old branch"], entryIds: ["a"] }) });
  await pending;
  assert.deepEqual(messages, []);
});

test("compaction-only recovery polls until idle and refreshes history", async () => {
  let compacting = true, finishes = 0;
  const observed = [];
  const finish = async () => { finishes++; };
  const { reconcile } = evaluate(
    between(hook, "const reconcileAgentState = useCallback", "// Recovery net for missed SSE events") +
    "exports.reconcile = reconcileAgentState;", {
      useCallback: (fn) => fn, isCompacting: true, agentRunningRef: { current: false },
      promptRunIdRef: { current: 1 }, sessionIdRef: { current: "s" },
      fetch: async () => ({ ok: true, json: async () => ({ running: true,
        state: { isStreaming: false, isPromptRunning: false, isCompacting: compacting } }) }),
      setIsCompacting: (value) => observed.push(value), normalizeQueuedMessages: () => ({}), setQueuedMessages() {},
      finishPromptWithoutStream: finish,
    },
  );
  await reconcile("s");
  assert.equal(finishes, 0);
  compacting = false;
  await reconcile("s");
  assert.deepEqual(observed, [true, false]);
  assert.equal(finishes, 1);
});

test("reopening a compacting-only session subscribes to completion events", async () => {
  const connected = [], compacting = [];
  evaluate(between(hook, "// Load session on mount", "  useEffect(() => {\n    onSystemPromptChange"), {
    useEffect: (fn) => fn(), session: { id: "s" }, sessionIdRef: { current: null },
    dismissedSubagentIdsRef: { current: null }, earlierHistoryKeyRef: { current: null }, setContextStartIndex() {},
    loadSession: async () => ({ running: true, state: { isCompacting: true } }), loadTools() {},
    connectEvents: (id) => connected.push(id), setIsCompacting: (value) => compacting.push(value),
  });
  await new Promise(setImmediate);
  assert.deepEqual(connected, ["s"]);
  assert.deepEqual(compacting, [true]);
});

test("startup failure restores the unsent draft; ambiguous POST failure does not resend it", async () => {
  for (const postStarted of [false, true]) {
    let messages = [], restored = null, settled = 0;
    const refs = Object.fromEntries([
      "agentRunningRef", "bashRunningRef", "navigationPendingRef", "rpcPromptPendingRef", "pendingScrollToUserRef",
      "completionScrollAllowedRef", "currentRunPromptRef", "currentRunStartedAtRef", "notifiedRunFinishedRef",
      "optimisticUserMessageKeyRef", "executeBashRef",
    ].map((name) => [name, { current: false }]));
    const images = [{ data: "base64", mimeType: "image/png", previewUrl: "blob:old" }];
    const send = callback("handleSend", "executeBash", {
      ...refs, isNew: !postStarted, newSessionCwd: "/work", newSessionModel: null,
      session: postStarted ? { id: "s" } : null, sessionIdRef: { current: null },
      ensuringNewSessionRef: { current: null }, promptRunIdRef: { current: 0 },
      cancelEventStreamGrace() {}, setMessages: (update) => { messages = update(messages); },
      userMessageKey: (msg) => String(msg.timestamp), setAgentRunning() {}, setAgentPhase() {}, setToolProgress() {},
      dispatch() {}, setPromptAnchorActive() {}, setPendingModel() {},
      ensureNewSession: async () => { throw new Error("startup failed"); },
      ensureEventsConnected: async () => {}, sendAgentCommand: async () => { throw new Error("connection lost"); },
      promoteNewSession() {}, waitForPromptSettlement: () => { settled++; }, addNotice() {}, closeEvents() {},
      opts: { chatInputRef: { current: { restoreDraft: (...args) => { restored = args; } } } },
      console: { error() {} },
    });
    await send("unsent message", images);
    assert.equal(messages.length, postStarted ? 1 : 0);
    assert.equal(settled, postStarted ? 1 : 0);
    if (postStarted) assert.equal(restored, null);
    else assert.deepEqual(restored, ["unsent message", images]);
  }
});

test("draft restoration retains text and attachments typed while startup was pending", () => {
  const input = source("../components/ChatInput.tsx");
  const method = between(input, "restoreDraft(text:", "    replaceMessage(");
  let value, images = [{ data: "new" }], saved;
  const ta = { value: "follow-up" };
  const { restore } = evaluate(`const handle = { ${method} }; exports.restore = handle.restoreDraft;`, {
    textareaRef: { current: ta }, valueRef: { current: "follow-up" }, attachedImagesRef: { current: images },
    draftKeyRef: { current: "s" }, setValue: (text) => { value = text; },
    setAttachedImages: (update) => { images = update(images); }, setAtQuery() {}, setHistoryMenuOpen() {},
    imageToDraftImage: (image) => ({ data: image.data }), draftImagesToAttachedImages: (items) => items,
    setDraft: (key, draft) => { saved = draft; }, requestAnimationFrame() {},
  });
  restore("failed message", [{ data: "old" }]);
  assert.equal(value, "failed message\n\nfollow-up");
  assert.equal(images.map((image) => image.data).join(","), "old,new");
  assert.equal(saved.value, value);
  assert.equal(saved.images.length, 2);
});
