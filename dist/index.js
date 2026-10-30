import { Config } from "./config.js";
import { ProgressiveToolSelection } from "./discovery.js";
import { activationProjection } from "./projection.js";
import { createSearchTool } from "./search.js";
export { Config } from "./config.js";
/** Cordis plugin name. */
export const name = 'progressive-tools';
/** Registry, prompt assembly, and recoverable discovery state. */
export const inject = ['tools', 'systemPrompt', 'sessionProjections'];
/**
 * Filter declarations and guard invocations in the mounting scope.
 * @param ctx - owner of the search tool, projection, prompt listener, and guard.
 * @param config - eager tool names and bounded search output.
 */
export function apply(ctx, config) {
    ctx.sessionProjections.register(activationProjection);
    const activatedNames = (agent) => agent === undefined ? []
        : ctx.sessionProjections.stateOf(agent.session, activationProjection.key) ?? [];
    ctx.tools.register(createSearchTool(ctx.tools, config, activatedNames));
    const selection = new ProgressiveToolSelection(ctx, config, activatedNames);
    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembly = await next();
        return { ...assembly, tools: selection.select(assembly.tools, context) };
    });
    ctx.tools.guard(exec => selection.deny(exec));
}
