/** Bounded keyword discovery over the caller's currently admitted registry. @module */
import type { Agent } from '@deepseek-ai/dsh-agent';
import { type ToolDefinition, type ToolsService } from '@deepseek-ai/dsh-tools';
import type { Config } from './config.ts';
/**
 * Build the mounting scope's search tool; the execution supplies its exact Agent and admission.
 * @param tools - retained registry used for scoped, live lookup.
 * @param config - eager names, result count, and description limits.
 * @param activatedNames - reads committed activation names for the caller; no Agent means no session activation.
 * @returns a registry-ready tool returning only names and short descriptions.
 */
export declare function createSearchTool(tools: ToolsService, config: Config, activatedNames: (agent: Agent | undefined) => readonly string[]): ToolDefinition;
