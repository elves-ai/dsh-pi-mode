import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Group from '@deepseek-ai/cordis-plugin-group'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-user-questions'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { response, run, schemas, ScriptedLlm } from './fixtures.ts'

const EAGER_TOOLS = [
  'ask_user_question', process.platform === 'win32' ? 'pwsh' : 'bash', 'edit', 'read',
  'read_image', 'skill', 'tool_search', 'working_directory', 'write',
].sort()

/** Import installed public modules while the real Loader owns their lifecycle. */
async function bundleHost(workspace: string): Promise<Context> {
  expect(import.meta.resolve('@elves-ai/dsh-pi-mode')).toBe(new URL('../dist/index.js', import.meta.url).href)
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.baseUrl = new URL('../', import.meta.url).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  ctx.loader.internal = {
    version: 'v2', loadCache: new Map(),
    import: specifier => import(/* @vite-ignore */ specifier),
    register() { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob() { throw new Error('unexpected module job') },
    resolveSync() { throw new Error('unexpected synchronous resolution') },
    load() { throw new Error('unexpected module load') },
  }
  const patches = loadOverlayPatches('pi-mode-test', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
  await ctx.loader.create({
    name: 'cordis:include',
    config: {
      path: new URL('./fixtures/host.cordis.yml', import.meta.url).href,
      patches: [...patches,
        { id: 'attachments', config: { dshHome: join(workspace, '.dsh') } },
        { id: 'working-directory', config: { defaultDirectory: workspace } },
      ],
    },
  })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const presets = await ctx.agentPresets.list()
  expect(presets).toContainEqual(expect.objectContaining({ id: 'pi-mode', name: 'Pi mode (plugin)' }))
  expect(presets.find(preset => preset.id === 'pi-mode')?.broken).toBeUndefined()
  expect(ctx.agentPresets.inspectCompositions().find(preset => preset.id === 'pi-mode')?.leakedServices).toEqual([])
  return ctx
}

it('loads the distributable patch and asks, discovers, then executes through real services', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'elves-pi-mode-bundle-'))
  let ctx: Context | undefined
  try {
    await writeFile(join(workspace, 'needle.txt'), 'fixture content\n')
    ctx = await bundleHost(workspace)
    const humanRequests: string[] = []
    ctx.on('user-questions/request', async (request) => {
      humanRequests.push(request.questions[0]?.question ?? '')
      return { answers: [{ id: 'target', selected: ['Text files'], custom: 'needle.txt' }] }
    })
    const adapter = new ScriptedLlm([
      response([{ name: 'ask_user_question', args: {
        questions: [{ id: 'target', question: 'Which files should I inspect?', options: [{ label: 'Text files' }] }],
      } }]),
      response([{ name: 'tool_search', args: { query: 'glob' } }]),
      response([{ name: 'glob', args: { pattern: '*.txt' } }]),
      response(),
    ])
    ctx.llm.registerAdapter(['scripted'], adapter)
    const pi = await ctx.agents.create({
      sessionId: SessionId('pi-bundle'), meta: { cwd: workspace },
      agentOptions: { provider: 'scripted', model: 'scripted' },
      setup: async (agentCtx) => { await ctx!.agentPresets.mount(agentCtx, 'pi-mode') },
    })
    const second = await ctx.agents.create({
      sessionId: SessionId('pi-isolated'), meta: { cwd: workspace },
      setup: async (agentCtx) => { await ctx!.agentPresets.mount(agentCtx, 'pi-mode') },
    })
    const foreign = await ctx.agents.create({ sessionId: SessionId('native-isolated'), meta: { cwd: workspace } })
    expect(await schemas(ctx, pi.agent)).toEqual(EAGER_TOOLS)
    expect(ctx.tools.get('ask_user_question', foreign.agent)).toBeUndefined()
    expect(ctx.tools.get('tool_search', foreign.agent)).toBeUndefined()
    const rejected = await ctx.tools.execute({
      agent: pi.agent, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: ToolCallId('before-search'), name: 'glob', arguments: '{"pattern":"*.txt"}' }],
    })
    expect(rejected.results[0]?.result).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    await run(ctx, pi.agent)
    expect(humanRequests).toEqual(['Which files should I inspect?'])
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(EAGER_TOOLS)
    const afterAnswer = adapter.requests[1]
    expect(afterAnswer?.tools?.map(tool => tool.name)).toEqual(EAGER_TOOLS)
    expect(afterAnswer?.messages.filter(message => message.role === 'tool')).toContainEqual(expect.objectContaining({
      content: [{ type: 'text', text: '{"answers":[{"id":"target","selected":["Text files"],"custom":"needle.txt"}]}' }],
    }))
    expect(adapter.requests[2]?.tools?.map(tool => tool.name)).toContain('glob')
    expect(adapter.requests[3]?.messages.filter(message => message.role === 'tool').at(-1)).toMatchObject({
      isError: false,
      content: [expect.objectContaining({ type: 'text', text: expect.stringContaining('needle.txt') })],
    })
    const events = pi.agent.session.snapshotEvents()
    expect(events.filter(event => event.type === 'tool/result').map(event => event.data.message.isError)).toEqual([false, false, false])
    expect(await schemas(ctx, second.agent)).toEqual(EAGER_TOOLS)
    const secondDenied = await ctx.tools.execute({
      agent: second.agent, signal: new AbortController().signal,
      calls: [{ type: 'tool-call', id: ToolCallId('other-agent'), name: 'glob', arguments: '{"pattern":"*.txt"}' }],
    })
    expect(secondDenied.results[0]?.result.isError).toBe(true)
    expect(ctx.agentPresets.composedPreset(pi.agent.ctx)).toBe('pi-mode')
    expect(ctx.agentPresets.inspectCompositions(pi.agent.ctx)[0]?.modules).toContainEqual(expect.objectContaining({
      moduleName: '@elves-ai/dsh-pi-mode',
    }))
    const tools = ctx.tools
    await ctx.fiber.dispose()
    expect(tools.get('tool_search', pi.agent)).toBeUndefined()
    expect(tools.get('ask_user_question', pi.agent)).toBeUndefined()
    await expect(tools.execute({ agent: pi.agent, calls: [], signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'TOOL_EXECUTOR_UNAVAILABLE' })
  } finally {
    await ctx?.fiber.dispose()
    await rm(workspace, { recursive: true, force: true })
  }
})
