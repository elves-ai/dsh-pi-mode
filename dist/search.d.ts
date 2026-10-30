/** Bounded keyword discovery over the caller's scope-visible registry. @module */
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type ToolDefinition, type ToolRuntime } from '@deepseek-ai/dsh-tools';
import type { Config } from './config.ts';
/**
 * Build the mounting scope's search tool; the execution supplies its exact Agent.
 * @param tools - retained registry used for scoped, live lookup.
 * @param config - eager names, result count, and description limits.
 * @param activatedNames - reads committed activation names for the caller; no Agent means no session activation.
 * @returns a registry-ready tool returning only names and short descriptions.
 */
export declare function createSearchTool(tools: ToolRuntime, config: Config, activatedNames: (agent: Agent | undefined) => readonly string[]): ToolDefinition;
