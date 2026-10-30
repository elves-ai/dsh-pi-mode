import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope';
import { projectToolSchema, ToolNotFoundError } from '@deepseek-ai/dsh-tools';
import { executeToolBatch, ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';
/** Per-Agent reader supplies replayed activations without mutable shared selection. */
export class ProgressiveToolExecutor {
    ctx;
    config;
    activatedNames;
    eager;
    validatedEagerNames = false;
    constructor(ctx, config, activatedNames) {
        this.ctx = ctx;
        this.config = config;
        this.activatedNames = activatedNames;
        this.eager = new Set(['tool_search', ...config.eagerTools]);
    }
    describe(tools) {
        if (!this.validatedEagerNames) {
            // Inspect each ancestor at its own scope so an Agent restriction cannot
            // turn a registered eager name into a configuration error.
            const scopes = [...scopeChainOf(scopeOf(this.ctx)), undefined];
            const missing = [...this.eager].filter(name => !scopes.some(scope => this.ctx.tools.get(name, scope) !== undefined));
            if (missing.length > 0)
                throw new Error(`eagerTools names unregistered tools: ${missing.join(', ')}`);
            this.validatedEagerNames = true;
        }
        const active = new Set([...this.eager, ...this.activatedNames()]);
        return { schemas: tools.filter(tool => active.has(tool.name)).map(tool => projectToolSchema(tool, false)) };
    }
    execute(input) {
        // A successful search in this response must not authorize a sibling call,
        // even when ordered settlement commits its result before the sibling starts.
        const active = new Set([...this.eager, ...this.activatedNames()]);
        const tools = this.ctx.tools;
        const pipeline = new ToolExecutionPipeline(this.ctx, {
            get: (name, scope, toolSet) => tools.executable(name, scope, toolSet),
            reject: name => active.has(name) ? undefined : new ToolNotFoundError(name, `search for \`${name}\` with tool_search first; call it in your next response after its schema is available`),
        });
        return executeToolBatch(input, pipeline, () => this.config.maxParallelToolCalls);
    }
}
