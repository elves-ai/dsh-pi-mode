/** Session-local progressive discovery using the DSH 0.2.1 prompt and tool APIs. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Config } from './config.ts'
import { ProgressiveToolSelection } from './discovery.ts'
import { activationProjection } from './projection.ts'
import { createSearchTool } from './search.ts'

export { Config } from './config.ts'

/** Cordis plugin name. */
export const name = 'progressive-tools'
/** Registry, prompt assembly, and recoverable discovery state. */
export const inject = ['tools', 'systemPrompt', 'sessionProjections']

/**
 * Filter declarations and guard invocations in the mounting scope.
 * @param ctx - owner of the search tool, projection, prompt listener, and guard.
 * @param config - eager tool names and bounded search output.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.sessionProjections.register(activationProjection)
  const activatedNames = (agent: Agent | undefined): readonly string[] => agent === undefined ? []
    : ctx.sessionProjections.stateOf(agent.session, activationProjection.key) ?? []
  ctx.tools.register(createSearchTool(ctx.tools, config, activatedNames))
  const selection = new ProgressiveToolSelection(ctx, config, activatedNames)
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    return { ...assembly, tools: selection.select(assembly.tools, context) }
  })
  ctx.tools.guard(exec => selection.deny(exec))
}
