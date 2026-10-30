import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Progressive from '../src/index.ts'
import { response, run, ScriptedLlm, tool } from './fixtures.ts'

it('boots real Loader YAML and discovers, then calls through a second model response', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.baseUrl = pathToFileURL(fileURLToPath(new URL('./fixtures/', import.meta.url))).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjections],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', Tools],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@elves-ai/dsh-pi-mode', Progressive],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  ctx.loader.internal = {
    version: 'v2', loadCache: new Map(),
    async import(specifier) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    register() { throw new Error('unexpected loader hook registration') },
    getOrCreateModuleJob() { throw new Error('unexpected module job') },
    resolveSync() { throw new Error('unexpected synchronous resolution') },
    load() { throw new Error('unexpected module load') },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: new URL('./fixtures/cordis.yml', import.meta.url).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  expect([...ctx.loader.entries()].filter(entry => !entry.disabled && entry.fiber === undefined)).toEqual([])
  ctx.tools.register(tool('read'))
  let executed = 0
  ctx.tools.register(tool('deferred', 'A deferred capability with hidden parameter details.', async () => { executed++; return 'executed' }))
  const standalone = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('standalone'), name: 'tool_search', arguments: { query: 'deferred' },
  })
  expect(standalone.isError).toBe(false)
  const adapter = new ScriptedLlm([
    response([{ name: 'tool_search', args: { query: 'deferred' } }]),
    response([{ name: 'deferred', args: {} }]),
    response(),
  ])
  ctx.llm.registerAdapter(['scripted'], adapter)
  const handle = await ctx.agents.create({ sessionId: SessionId('loader'), agentOptions: { provider: 'scripted', model: 'scripted' } })
  await run(ctx, handle.agent)
  expect(adapter.requests.map(request => request.tools?.map(schema => schema.name))).toEqual([
    ['read', 'tool_search'], ['deferred', 'read', 'tool_search'], ['deferred', 'read', 'tool_search'],
  ])
  expect(executed).toBe(1)
  const searchResult = handle.agent.session.snapshotEvents().find(event => event.type === 'tool/result')
  expect(searchResult).toMatchObject({ data: {
    meta: { progressiveToolActivation: ['deferred'] },
    message: { content: [{ type: 'text', text: '[{"name":"deferred","description":"A deferred capabili…"}]' }] },
  } })
  const eagerSize = JSON.stringify(adapter.requests[0]?.tools).length
  const fullSize = JSON.stringify(adapter.requests[1]?.tools).length
  expect(eagerSize).toBeLessThan(fullSize)
  expect(fullSize - eagerSize).toBeGreaterThan(150)
  await handle.dispose()
}, 30_000)
