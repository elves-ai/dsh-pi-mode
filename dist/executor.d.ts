/** Native execution with session-derived declaration and invocation admission. @module */
import type { Context } from '@deepseek-ai/cordis';
import type { ToolBatchInput, ToolBatchResult, ToolDefinition, ToolExecutor, ToolModelInput } from '@deepseek-ai/dsh-tools';
import type { Config } from './config.ts';
/** Per-Agent reader supplies replayed activations without mutable shared selection. */
export declare class ProgressiveToolExecutor implements ToolExecutor {
    private readonly ctx;
    private readonly config;
    private readonly activatedNames;
    private readonly eager;
    private validatedEagerNames;
    constructor(ctx: Context, config: Config, activatedNames: () => readonly string[]);
    describe(tools: readonly ToolDefinition[]): ToolModelInput;
    execute(input: ToolBatchInput): Promise<ToolBatchResult>;
}
