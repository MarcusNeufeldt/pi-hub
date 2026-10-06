const LEGACY_BUILTIN_TOOL_NAMES: Record<string, string> = {
  Read: "read",
  Bash: "bash",
  Edit: "edit",
  Write: "write",
  Grep: "grep",
  Find: "find",
  Ls: "ls",
};

/**
 * Keep Pi's built-in tool names canonical without changing extension names.
 * `undefined` means the caller omitted selection and should keep SDK defaults;
 * an explicit empty array remains an all-tools-disabled allow-list.
 */
export function normalizeToolNames(toolNames: string[] | undefined): string[] | undefined {
  if (toolNames === undefined) return undefined;
  return [...new Set(toolNames.map((name) => Object.hasOwn(LEGACY_BUILTIN_TOOL_NAMES, name)
    ? LEGACY_BUILTIN_TOOL_NAMES[name]
    : name))];
}
