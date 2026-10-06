import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as Type from "typebox";
import { createJiti } from "jiti";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { hubRuntimeExtensions, toolsForPreset } = await jiti.import("./runtime-tool-policy.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

test("presets retain active declared extensions without enabling inactive/deferred tools", () => {
  const session = {
    getAllTools: () => [
      { name: "read" }, { name: "bash" }, { name: "powershell" },
      { name: "mcp", exposure: "direct" }, { name: "codemode", exposure: "direct" },
      { name: "tool_search", exposure: "direct" }, { name: "hidden", exposure: "hidden" },
      { name: "remote", exposure: "deferred" },
    ],
    getActiveToolNames: () => ["read", "bash", "powershell", "mcp", "codemode", "hidden", "remote"],
  };
  assert.deepEqual(toolsForPreset(session, ["read"]), ["read", "mcp", "codemode"]);
  assert.deepEqual(toolsForPreset(session, []), []);
});

test("host policy forces all-off prompt and blocks calls without writing derived state", () => {
  const policy = { toolsDisabled: true };
  const factories = hubRuntimeExtensions(policy);
  assert.deepEqual(factories.filter((entry) => entry.builtin).map((entry) => entry.name), ["codemode", "tool-search", "mcp"]);
  const handlers = new Map();
  const active = [];
  factories.find((entry) => entry.name === "hub-tool-policy").factory({
    on: (name, handler) => handlers.set(name, handler),
    setActiveTools: (tools) => active.push(tools),
  });
  const event = { systemPromptOptions: { selectedTools: ["read"] } };
  handlers.get("before_agent_start")(event);
  assert.equal(event.systemPromptOptions.forceSystemPrompt, "");
  assert.deepEqual(event.systemPromptOptions.selectedTools, []);
  assert.equal(handlers.get("tool_call")().block, true);
  assert.deepEqual(active, [[]]);
  policy.toolsDisabled = false;
  assert.equal(handlers.get("tool_call")(), undefined);
});

test("Pi 1.0.3 initializes native builtins and wrapper all-off against scratch state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-hub-runtime-103-"));
  // Native factories use getAgentDir() as well as the loader's agentDir.
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  let session, wrapper;
  try {
    for (const initiallyDisabled of [false, true]) {
      const policy = { toolsDisabled: initiallyDisabled };
      const modelRuntime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"), modelsPath: null,
        modelsStorePath: join(dir, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false,
      });
      const model = modelRuntime.getModels()[0];
      assert.ok(model, "SDK must have static models without a network refresh");
      const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"] });
      let plugin;
      let executions = 0;
      const registrationFixture = { name: "registration-fixture", factory: (pi) => { plugin = pi; } };
      const services = await createAgentSessionServices({
        cwd: dir, agentDir: dir, modelRuntime, settingsManager,
        resourceLoaderOptions: { extensionFactories: [...hubRuntimeExtensions(policy), registrationFixture], noSkills: true, noPromptTemplates: true, noThemes: true },
      });
      ({ session } = await createAgentSessionFromServices({ services, model, sessionManager: SessionManager.inMemory(dir) }));
      await session.bindExtensions({});
      assert.ok(session.getAllTools().some((tool) => tool.name === "codemode"));
      assert.ok(session.getActiveToolNames().includes("codemode"));
      assert.ok(!session.getActiveToolNames().includes("tool_search"));
      wrapper = new AgentSessionWrapper(session, policy);
      wrapper.setForceEmptySystemPrompt(true);
      assert.deepEqual(session.getActiveToolNames(), []);
      assert.equal((await wrapper.send({ type: "get_state" })).systemPrompt, "");
      const preflight = await session.extensionRunner.emitBeforeAgentStart("scratch fixture", undefined, {
        cwd: dir, selectedTools: [], toolSnippets: {}, toolGuidelines: {},
        promptGuidelines: [], appendSystemPrompt: "", sections: {}, contextFiles: [], skills: [],
      });
      assert.equal(preflight.systemPromptOptions.forceSystemPrompt, "");
      assert.deepEqual(preflight.systemPromptOptions.selectedTools, []);
      assert.deepEqual(session.getCallableToolNames(), []);
      for (const phase of ["bound", "off", "reload"]) {
        if (phase === "off") await wrapper.send({ type: "set_tools", toolNames: [] });
        if (phase === "reload") await wrapper.send({ type: "reload" });
        for (const exposure of ["direct", "deferred"]) {
          plugin.registerTool({
            name: `late_${phase}_${exposure}`, label: "Scratch fixture", description: "Scratch fixture",
            parameters: Type.Object({}), exposure,
            execute: async () => { executions++; return { content: [{ type: "text", text: "fixture" }], details: {} }; },
          });
        }
        assert.deepEqual(session.getActiveToolNames(), [], `all-off must survive ${phase} registration`);
        // Supply synthetic assistant provenance for the real nested tool pipeline,
        // without prompting or contacting a provider.
        session.agent.state.messages.push({
          role: "assistant", content: [{ type: "toolCall", id: `scratch-${phase}`, name: "codemode", arguments: { code: "fixture" } }],
          api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        });
        const ctx = session.extensionRunner.createToolContext(`scratch-${phase}`, undefined);
        const outcome = await ctx.executeTool(`late_${phase}_deferred`, {});
        assert.equal(outcome.isError, true);
        assert.match(outcome.result.content[0].text, /Tools are disabled/);
        assert.equal(executions, 0);
      }
      await wrapper.send({ type: "set_tools", toolNames: ["read"] });
      assert.ok(session.getActiveToolNames().includes("read"));
      assert.ok(session.getActiveToolNames().includes("codemode"), "restore the user's active code mode when leaving all-off");
      assert.ok(!session.getActiveToolNames().includes("tool_search"));
      assert.ok(!session.getActiveToolNames().some((name) => name.startsWith("late_")));
      assert.notEqual((await wrapper.send({ type: "get_state" })).systemPrompt, "");
      const script = "text(await tools.late_reload_deferred({}));";
      session.agent.state.messages.push({
        ...session.agent.state.messages.at(-1),
        content: [{ type: "toolCall", id: "scratch-sandbox", name: "codemode", arguments: { code: script } }],
      });
      const signal = new AbortController().signal;
      const sandboxResult = await session.getToolDefinition("codemode").execute(
        "scratch-sandbox", { code: script }, signal, undefined,
        session.extensionRunner.createToolContext("scratch-sandbox", signal),
      );
      assert.equal(executions, 1, "native sandbox may invoke the harmless deferred fixture after tools are enabled");
      assert.equal(sandboxResult.details.calls[0].status, "ok");
      assert.ok(sandboxResult.content.some((block) => block.type === "text" && block.text.includes("fixture")));
      wrapper.destroy();
      wrapper = undefined;
      session = undefined;
    }
  } finally {
    wrapper?.destroy();
    session?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
});
