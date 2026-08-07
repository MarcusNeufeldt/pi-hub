/**
 * Public entrypoint for the Pi Hub AgentExecutionCoordinator module
 * (design doc §8).
 *
 * Importers go through here so the internal file layout can evolve without
 * churning call sites. Mirrors the scheduler/telegram module boundary pattern.
 */

export {
  AgentExecutionCoordinator,
  getAgentExecutionCoordinator,
  __resetAgentExecutionCoordinator,
  type AcquireInput,
  type AcquireResult,
} from "./agent-execution-coordinator";

export {
  telegramOwnerKey,
  webOwnerKey,
  schedulerOwnerKey,
  apiOwnerKey,
  SOURCE_LABELS,
  type AgentRunContext,
  type RunSource,
} from "./run-context";
