/** Session-local progressive tool discovery through the existing executor seam. @module */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.ts';
export { Config } from './config.ts';
/** Cordis plugin name. */
export declare const name = "progressive-tool-executor";
/** Registrations, Agent lifecycle, and recoverable discovery state. */
export declare const inject: string[];
/**
 * Select progressive discovery in the mounting scope and its live Agents.
 * @param ctx - owner of the search tool, projection, and per-Agent executor selections.
 * @param config - eager tool names, bounded search output, and batch concurrency.
 * @returns after projection registration and existing Agent attachment complete.
 */
export declare function apply(ctx: Context, config: Config): Promise<void>;
