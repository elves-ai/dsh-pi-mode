/** Session-local progressive tool discovery through the existing executor seam. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-session-projection'
import { Config } from './config.ts'
import { ProgressiveToolExecutor } from './executor.ts'
import { activationProjection } from './projection.ts'
import { createSearchTool } from './search.ts'

export { Config } from './config.ts'

/** Cordis plugin name. */
export const name = 'progressive-tool-executor'
/** Registrations, Agent lifecycle, and recoverable discovery state. */
export const inject = ['tools', 'agents', 'sessionProjections']

/**
 * Select progressive discovery in the mounting scope and its live Agents.
 * @param ctx - owner of the search tool, projection, and per-Agent executor selections.
 * @param config - eager tool names, bounded search output, and batch concurrency.
 * @returns after projection registration and existing Agent attachment complete.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const projection = await ctx.sessionProjections.register(activationProjection)
  ctx.tools.register(createSearchTool(ctx.tools, config,
    agent => agent === undefined ? [] : projection.stateOf(agent.session)))
  ctx.tools.setExecutor(new ProgressiveToolExecutor(ctx, config, () => []))

  const registrations = new Map<Agent, () => void | Promise<void>>()
  ctx.effect(() => async () => {
    for (const dispose of registrations.values()) await dispose()
    registrations.clear()
  })
  const attach = (agent: Agent): void => {
    const dispose = agent.ctx.effect(function* () {
      yield agent.ctx.tools.setExecutor(new ProgressiveToolExecutor(
        agent.ctx, config, projection.readerFor(agent.session),
      ))
      yield () => { registrations.delete(agent) }
    })
    registrations.set(agent, dispose)
  }
  ctx.on('agent/created', ({ agent }) => { attach(agent) })
  const scope = scopeOf(ctx)
  for (const agent of ctx.agents.list()) {
    if (scope === undefined || scopeChainOf(agent).includes(scope)) attach(agent)
  }
}
