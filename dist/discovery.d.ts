/** Scoped declaration filtering and request-frozen execution admission. @module */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt';
import type { ToolSchema } from '@deepseek-ai/dsh-llm';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { Config } from './config.ts';
/** Each model request fixes the callable names until the next request assembly. */
export declare class ProgressiveToolSelection {
    private readonly ctx;
    private readonly activatedNames;
    private readonly eager;
    private readonly requests;
    private validatedEagerNames;
    constructor(ctx: Context, config: Config, activatedNames: (agent: Agent | undefined) => readonly string[]);
    /**
     * Filter existing schemas without widening registry restrictions.
     * @param schemas - schemas assembled by the Host.
     * @param context - caller and optional running-turn signal; diagnostics do not change admission.
     * @returns eager and durably discovered schemas.
     */
    select(schemas: readonly ToolSchema[], context: AssembleContext): ToolSchema[];
    /**
     * Deny tools not activated when the current request was assembled.
     * @param exec - Host-validated execution; all other Host guards still apply.
     * @returns an actionable denial, or undefined to delegate admission.
     */
    deny(exec: ToolExecution): string | undefined;
}
