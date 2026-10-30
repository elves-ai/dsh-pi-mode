/** Session-local progressive discovery using the DSH 0.2.1 prompt and tool APIs. @module */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.ts';
export { Config } from './config.ts';
/** Cordis plugin name. */
export declare const name = "progressive-tools";
/** Registry, prompt assembly, and recoverable discovery state. */
export declare const inject: string[];
/**
 * Filter declarations and guard invocations in the mounting scope.
 * @param ctx - owner of the search tool, projection, prompt listener, and guard.
 * @param config - eager tool names and bounded search output.
 */
export declare function apply(ctx: Context, config: Config): void;
