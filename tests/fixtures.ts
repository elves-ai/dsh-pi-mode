/** Real loop fixtures shared by discovery and Loader tests. */
import { onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, createToolResultMessage, LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { bindScopeParent, createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import * as Progressive from '../src/index.ts'

export class ScriptedLlm extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: StreamChunk[][] = []) { super() }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('script exhausted')
    yield* chunks
  }
}

export function response(calls: Array<{ name: string; args: object }> = []): StreamChunk[] {
  if (calls.length === 0) return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'done' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  return [
    ...calls.flatMap(({ name, args }, index): StreamChunk[] => {
      const id = ToolCallId(`call-${index}`)
      const argumentsJson = JSON.stringify(args)
      return [
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id, name, argumentsDelta: argumentsJson },
        { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: argumentsJson } },
      ]
    }),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

export async function services(ctx: Context, persistenceRoot?: string, maxParallelToolCalls = 10): Promise<void> {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(AgentRegistry)
  if (persistenceRoot !== undefined) await ctx.plugin(JsonlPersistence, { root: persistenceRoot, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls })
}

export async function setup(config: Partial<Progressive.Config> = {}, persistenceRoot?: string, maxParallelToolCalls = 10) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await services(ctx, persistenceRoot, maxParallelToolCalls)
  let preset!: Scope
  const key = {}
  await ctx.plugin(Object.assign((inner: Context) => { preset = createScope(inner, key) },
    { inject: ['tools', 'agents', 'sessionProjections'] }))
  const options = { eagerTools: [], ...config }
  const fiber = preset.ctx.plugin(Progressive, options)
  await fiber
  const create = async (id: string, seed?: readonly SessionEvent[]) => ctx.agents.create({
    sessionId: SessionId(id),
    ...seed === undefined ? {} : { seed },
    agentOptions: { provider: 'scripted', model: 'scripted' },
    setup: (_agentCtx, agent) => { bindScopeParent(agent, key) },
  })
  return { ctx, preset, key, fiber, options, create }
}

export function tool(name: string, description = `${name} capability`, execute = async () => name) {
  return defineTool({
    name, description,
    parameters: { value: { type: 'string', description: 'A deliberately verbose parameter withheld until discovery.' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    execute,
  })
}

/** Single-call unit helper; real-loop tests own response scheduling and durable settlement. */
export async function call(
  ctx: Context, agent: Agent, name: string, args: object = {},
  options: { log?: boolean; signal?: AbortSignal } = {},
) {
  const callId = ToolCallId(`call-${agent.session.seq}`)
  const callEvent = options.log === false ? undefined : agent.session.append('tool/call', {
    turn: 1, step: 1, callId, name, arguments: JSON.stringify(args),
  })
  const result = await ctx.tools.execute({
    agent, callId, name, arguments: args, signal: options.signal ?? new AbortController().signal,
  })
  if (callEvent !== undefined) agent.session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: result.content, isError: result.isError }),
    ...result.meta === undefined ? {} : { meta: result.meta },
  }, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] })
  return result
}

export async function schemas(ctx: Context, agent: Agent): Promise<string[]> {
  return (await ctx.systemPrompt.assemble({ scope: agent, agent, signal: new AbortController().signal })).tools.map(tool => tool.name)
}

export async function run(ctx: Context, agent: Agent): Promise<void> {
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', (event) => {
      if (event.agent === agent && event.status === 'idle') { dispose(); resolve() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await idle
}
