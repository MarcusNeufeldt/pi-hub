import { createCodemodeExtension, createMcpExtension, createToolSearchExtension, type ExtensionFactory, type InlineExtension } from "@earendil-works/pi-coding-agent";

export interface RuntimeToolPolicy {
  toolsDisabled: boolean;
}

/** Match CLI builtin selection without changing the user's extension settings. */
export function hubRuntimeExtensions(policy: RuntimeToolPolicy): InlineExtension[] {
  const guard: ExtensionFactory = (pi) => {
    pi.on("before_agent_start", (event) => {
      if (!policy.toolsDisabled) return;
      pi.setActiveTools([]);
      event.systemPromptOptions.selectedTools = [];
      event.systemPromptOptions.forceSystemPrompt = "";
    });
    pi.on("tool_call", () => policy.toolsDisabled
      ? { block: true, reason: "Tools are disabled for this session." }
      : undefined);
  };
  return [
    { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
    { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
    { name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
    { name: "hub-tool-policy", factory: guard },
  ];
}

/** Keep the public mutable loadout empty even when the SDK registers tools asynchronously. */
export function enforceDisabledToolLoadout(state: { tools?: unknown[] }, policy: RuntimeToolPolicy): void {
  const descriptor = Object.getOwnPropertyDescriptor(state, "tools");
  if (!descriptor?.get || !descriptor.set || !descriptor.configurable) {
    throw new Error("Pi host requires a mutable tools loadout accessor");
  }
  const setTools = descriptor.set;
  Object.defineProperty(state, "tools", {
    ...descriptor,
    set(tools: unknown[]) { setTools.call(state, policy.toolsDisabled ? [] : tools); },
  });
  if (policy.toolsDisabled) state.tools = [];
}

/** Retain already-active extensions, not every registered/deferred tool. */
export function toolsForPreset(session: {
  getAllTools(): Array<{ name: string; exposure?: string }>;
  getActiveToolNames(): string[];
}, requested: string[], resumedActive: string[] = []): string[] {
  if (requested.length === 0) return [];
  const builtins = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);
  const active = new Set([...session.getActiveToolNames(), ...resumedActive]);
  const extensions = session.getAllTools()
    .filter((tool) => active.has(tool.name) && !builtins.has(tool.name)
      && (tool.exposure === undefined || tool.exposure === "direct" || tool.exposure === "model-only"))
    .map((tool) => tool.name);
  return [...new Set([...requested, ...extensions])];
}
