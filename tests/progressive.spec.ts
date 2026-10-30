import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import * as Progressive from '../src/index.ts'
import { Config } from '../src/config.ts'
import { activationProjection } from '../src/projection.ts'
import { batch, response, run, schemas, ScriptedLlm, services, setup, tool } from './fixtures.ts'

async function discover(harness: Awaited<ReturnType<typeof setup>>, agent: Parameters<typeof batch>[0], query = 'deferred') {
  return harness.ctx.tools.execute(batch(agent, [{ name: 'tool_search', args: { query } }]))
}

describe('progressive tool execution', () => {
  it('requires explicit eager names and validates all configurable limits', () => {
    expect(activationProjection.key).toBe('elves-ai/dsh-pi-mode/activation')
    expect(() => Config({} as never)).toThrow()
    expect(Config({ eagerTools: [] })).toEqual({ eagerTools: [], maxSearchResults: 5, descriptionMaxLength: 160, maxParallelToolCalls: 10 })
    for (const key of ['maxSearchResults', 'descriptionMaxLength', 'maxParallelToolCalls']) {
      expect(() => Config({ eagerTools: [], [key]: 0 })).toThrow()
    }
  })

  it('withholds schemas, rejects call-before-search, and activates only on a committed result', async () => {
    const h = await setup({ eagerTools: ['read'] })
    let calls = 0
    h.ctx.tools.register(tool('read'))
    h.ctx.tools.register(tool('deferred', 'Deferred useful capability.', async () => { calls++; return 'worked' }))
    const { agent } = await h.create('first')
    expect(await schemas(h.ctx, agent)).toEqual(['read', 'tool_search'])
    const refused = await h.ctx.tools.execute(batch(agent, [{ name: 'deferred' }]))
    expect(refused.results[0]?.result).toMatchObject({ isError: true, error: { info: { code: 'UNKNOWN_TOOL' } } })
    expect(calls).toBe(0)
    const search = await discover(h, agent)
    expect(search.results[0]?.result).toMatchObject({
      isError: false,
      value: [{ name: 'deferred', description: 'Deferred useful capability.' }],
      meta: { progressiveToolActivation: ['deferred'] },
    })
    expect(JSON.stringify(search)).not.toContain('parameters')
    expect(await schemas(h.ctx, agent)).toEqual(['deferred', 'read', 'tool_search'])
    expect((await h.ctx.tools.execute(batch(agent, [{ name: 'deferred' }]))).results[0]?.result.isError).toBe(false)
    expect(calls).toBe(1)
  })

  it('does not activate unlogged searches, invalid queries, blocked or cancelled results', async () => {
    const h = await setup()
    h.ctx.tools.register(tool('deferred'))
    const { agent } = await h.create('no-commit')
    const { log: _log, ...unlogged } = batch(agent, [{ name: 'tool_search', args: { query: 'deferred' } }])
    await h.ctx.tools.execute(unlogged)
    expect(await schemas(h.ctx, agent)).toEqual(['tool_search'])
    for (const query of ['', '!!!']) {
      expect((await discover(h, agent, query)).results[0]?.result.isError).toBe(true)
    }
    const block = agent.ctx.on('tools/post-execute', async (_exec, _result, _next) => ({ kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }))
    expect((await discover(h, agent)).results[0]?.result.isError).toBe(true)
    block()
    const controller = new AbortController()
    const cancel = agent.ctx.on('tools/post-execute', (_exec, _result, next) => { controller.abort(); return next() })
    expect((await h.ctx.tools.execute(batch(agent, [{ name: 'tool_search', args: { query: 'deferred' } }], { signal: controller.signal }))).results[0]?.result.isError).toBe(true)
    cancel()
    expect(await schemas(h.ctx, agent)).toEqual(['tool_search'])
  })

  it.each([1, 4])('freezes activation for the entire batch at concurrency %i', async (maxParallelToolCalls) => {
    const h = await setup({ maxParallelToolCalls })
    let calls = 0
    h.ctx.tools.register(tool('deferred', 'Deferred capability.', async () => { calls++; return 'ran' }))
    const { agent } = await h.create(`same-batch-${maxParallelToolCalls}`)
    const result = await h.ctx.tools.execute(batch(agent, [
      { name: 'tool_search', args: { query: 'deferred' } },
      { name: 'deferred' },
      { name: 'tool_search', args: { query: 'deferred' } },
      { name: 'deferred' },
    ]))
    expect(result.results.map(entry => entry.result.isError)).toEqual([false, true, false, true])
    expect(calls).toBe(0)
    expect(await schemas(h.ctx, agent)).toEqual(['deferred', 'tool_search'])
  })

  it('bounds deterministic search results without returning schemas', async () => {
    const h = await setup({ maxSearchResults: 2, descriptionMaxLength: 3, eagerTools: [] })
    h.ctx.tools.register(tool('b_lookup', '🔍📚😀long'))
    h.ctx.tools.register(tool('a_lookup', '🔍📚😀long'))
    h.ctx.tools.register(tool('c_lookup', 'lookup description'))
    h.ctx.tools.register(tool('d_lookup', '🔍📚😀long'))
    const { agent } = await h.create('bounds')
    const result = await discover(h, agent, 'lookup')
    expect(result.results[0]?.result).toMatchObject({ value: [
      { name: 'c_lookup', description: 'lo…' },
      { name: 'a_lookup', description: '🔍📚…' },
    ] })
    expect(await schemas(h.ctx, agent)).toEqual(['a_lookup', 'c_lookup', 'tool_search'])
    expect((await discover(h, agent, 'missing')).results[0]?.result).toMatchObject({ isError: false, value: [] })
  })

  it.each<[number, string]>([
    [1, '…'], [2, '🔍…'], [3, '🔍📚😀'], [4, '🔍📚😀'],
  ])('keeps truncation within a %i-code-point description limit', async (descriptionMaxLength, expected) => {
    const h = await setup({ descriptionMaxLength })
    h.ctx.tools.register(tool('unicode', '🔍📚😀'))
    const { agent } = await h.create(`unicode-${descriptionMaxLength}`)
    expect((await discover(h, agent, 'unicode')).results[0]?.result).toMatchObject({
      value: [{ name: 'unicode', description: expected }],
    })
  })

  it('discovers later matching tools with repeated bounded searches and excludes eager tools', async () => {
    const h = await setup({ eagerTools: ['read'] })
    h.ctx.tools.register(tool('read', 'lookup files'))
    for (let index = 0; index < 7; index++) h.ctx.tools.register(tool(`lookup_${index}`, 'lookup task'))
    const { agent } = await h.create('next-matches')
    const first = await discover(h, agent, 'lookup')
    expect(first.results[0]?.result).toMatchObject({
      value: Array.from({ length: 5 }, (_, index) => ({ name: `lookup_${index}`, description: 'lookup task' })),
    })
    const second = await discover(h, agent, 'lookup')
    expect(second.results[0]?.result).toMatchObject({ value: [
      { name: 'lookup_5', description: 'lookup task' }, { name: 'lookup_6', description: 'lookup task' },
    ] })
    expect((await discover(h, agent, 'lookup')).results[0]?.result).toMatchObject({ value: [] })
    expect(await schemas(h.ctx, agent)).toHaveLength(9)
  })

  it('does not share activation or scoped search candidates across Agents and presets', async () => {
    const h = await setup()
    h.ctx.tools.register(tool('deferred'))
    const a = (await h.create('isolated-a')).agent
    const b = (await h.create('isolated-b')).agent
    a.ctx.tools.register(tool('private', 'Private deferred tool.'))
    await discover(h, a)
    expect(await schemas(h.ctx, a)).toContain('private')
    expect(await schemas(h.ctx, b)).toEqual(['tool_search'])
    expect((await discover(h, b, 'private')).results[0]?.result).toMatchObject({ value: [] })
    const foreign = await h.ctx.agents.create({ sessionId: SessionId('foreign') })
    expect(await schemas(h.ctx, foreign.agent)).toEqual(['deferred'])
    expect(h.ctx.tools.get('tool_search', foreign.agent)).toBeUndefined()
  })

  it('retains conditional admission, restrictions, guards, and unload after discovery', async () => {
    const h = await setup({ eagerTools: [] })
    let enabled = false
    const remove = h.ctx.tools.register(tool('conditional'), { when: () => enabled })
    h.ctx.tools.register(tool('deferred'))
    const { agent } = await h.create('conditional')
    const resolve = () => h.ctx.tools.resolve({ agent, signal: new AbortController().signal, modelSelection: { provider: 'x', model: 'x' } })
    const unavailable = await resolve()
    expect((await h.ctx.tools.execute(batch(agent, [{ name: 'tool_search', args: { query: 'conditional' } }], { toolSet: unavailable }))).results[0]?.result).toMatchObject({ value: [] })
    unavailable.dispose()
    enabled = true
    const admitted = await resolve()
    expect((await h.ctx.tools.execute(batch(agent, [{ name: 'tool_search', args: { query: 'conditional' } }], { toolSet: admitted }))).results[0]?.result).toMatchObject({ value: [{ name: 'conditional' }] })
    expect((await h.ctx.tools.execute(batch(agent, [{ name: 'conditional' }], { toolSet: admitted }))).results[0]?.result.isError).toBe(false)
    expect((await h.ctx.tools.execute(batch(agent, [{ name: 'conditional' }]))).results[0]?.result.isError).toBe(true)
    const guard = agent.ctx.tools.guard(() => 'guard denied')
    expect((await h.ctx.tools.execute(batch(agent, [{ name: 'conditional' }], { toolSet: admitted }))).results[0]?.result.isError).toBe(true)
    guard()
    const restriction = agent.ctx.tools.restrict({ deny: ['conditional'] })
    expect((await h.ctx.tools.execute(batch(agent, [{ name: 'conditional' }], { toolSet: admitted }))).results[0]?.result.isError).toBe(true)
    restriction()
    remove()
    expect((await h.ctx.tools.execute(batch(agent, [{ name: 'conditional' }], { toolSet: admitted }))).results[0]?.result.isError).toBe(true)
    admitted.dispose()
    enabled = false
    await discover(h, agent)
    const deny = agent.ctx.tools.restrict({ deny: ['deferred'] })
    expect(await schemas(h.ctx, agent)).toEqual(['tool_search'])
    expect((await discover(h, agent)).results[0]?.result).toMatchObject({ value: [] })
    deny()
    expect(await schemas(h.ctx, agent)).toContain('deferred')
  })

  it('releases both owned selections and reattaches live Agents after HMR', async () => {
    const h = await setup()
    h.ctx.tools.register(tool('deferred'))
    const first = await h.create('hmr-a')
    const second = await h.create('hmr-b')
    const foreign = await h.ctx.agents.create({ sessionId: SessionId('hmr-foreign') })
    expect((await h.ctx.systemPrompt.assemble({ scope: h.key })).tools.map(tool => tool.name)).toEqual(['tool_search'])
    await discover(h, first.agent)
    await h.fiber.dispose()
    expect(h.ctx.tools.get('tool_search', first.agent)).toBeUndefined()
    await expect(schemas(h.ctx, first.agent)).rejects.toMatchObject({ code: 'TOOL_EXECUTOR_UNAVAILABLE' })
    const replacement = h.preset.ctx.plugin(Progressive, h.options)
    await replacement
    expect(await schemas(h.ctx, first.agent)).toEqual(['deferred', 'tool_search'])
    expect(await schemas(h.ctx, second.agent)).toEqual(['tool_search'])
    expect(await schemas(h.ctx, foreign.agent)).toEqual(['deferred'])
    await foreign.dispose()
    await first.dispose()
    await replacement.dispose()
    await h.preset.ctx.plugin(Progressive, h.options)
    expect(await schemas(h.ctx, second.agent)).toEqual(['tool_search'])
    await second.dispose()
  })

  it('cleans effects when unloaded while activation is pending', async () => {
    const h = await setup()
    const { agent } = await h.create('early-dispose')
    await h.fiber.dispose()
    const loading = h.preset.ctx.plugin(Progressive, h.options)
    await loading.dispose()
    expect(h.ctx.tools.get('tool_search', agent)).toBeUndefined()
    await expect(schemas(h.ctx, agent)).rejects.toMatchObject({ code: 'TOOL_EXECUTOR_UNAVAILABLE' })
    await h.preset.ctx.plugin(Progressive, h.options)
    expect(await schemas(h.ctx, agent)).toEqual(['tool_search'])
  })

  it('attaches existing Agents when mounted at deployment scope', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await services(ctx, undefined, false)
    const handle = await ctx.agents.create({ sessionId: SessionId('existing-root') })
    await ctx.plugin(Progressive, { eagerTools: [] })
    expect(await schemas(ctx, handle.agent)).toEqual(['tool_search'])
    await handle.dispose()
  })

  it('fails activation when projection registration rejects', async () => {
    const h = await setup()
    await h.fiber.dispose()
    const conflicting = await h.ctx.sessionProjections.register({ ...activationProjection, stateVersion: 99 })
    await expect(h.preset.ctx.plugin(Progressive, h.options)).rejects.toThrow()
    expect(h.ctx.tools.get('tool_search', h.key)).toBeUndefined()
    await conflicting.dispose()
  })

  it('replays activation on reconstructed and forked Sessions and restores compatible checkpoints', async () => {
    const h = await setup()
    h.ctx.tools.register(tool('deferred'))
    const { agent } = await h.create('history')
    await discover(h, agent)
    const events = agent.session.snapshotEvents()
    const restored = Session.create(SessionId('restored'), events)
    const forked = Session.create(SessionId('forked'), events,
      { ...agent.session.header, id: SessionId('forked'), isSeeded: true }, SessionLogOffset(events.length))
    const handle = await h.ctx.sessionProjections.register(activationProjection)
    expect(handle.stateOf(restored)).toEqual(['deferred'])
    expect(handle.stateOf(forked)).toEqual(['deferred'])
    const checkpoint = h.ctx.sessionProjections.checkpoint(agent.session)
    expect(checkpoint[activationProjection.key]?.val).toEqual(['deferred'])
    const restore = (rows: typeof checkpoint) => h.ctx.sessionProjections.restore(
      rows, events, SessionLogOffset(0), restored.header, SessionLogOffset(0),
    )
    expect(restore(checkpoint).checkpoint[activationProjection.key]?.val).toEqual(['deferred'])
    expect(restore({}).checkpoint[activationProjection.key]?.val).toEqual(['deferred'])
    const incompatible = { [activationProjection.key]: { ...checkpoint[activationProjection.key]!, ver: 999 } }
    expect(restore(incompatible).checkpoint[activationProjection.key]?.val).toEqual(['deferred'])
    const invalid = { [activationProjection.key]: { ...checkpoint[activationProjection.key]!, val: 42 } }
    expect(() => restore(invalid)).toThrow()
    h.ctx.tools.register(tool('extra'))
    await discover(h, agent, 'extra')
    const floor = h.ctx.sessionProjections.restoreFloor(checkpoint)
    if (floor === undefined) throw new Error('registered projections require a restore floor')
    const suffix = agent.session.snapshotEvents(floor)
    const replayed = h.ctx.sessionProjections.restore(checkpoint, suffix, floor, restored.header, SessionLogOffset(0))
    expect(replayed.checkpoint[activationProjection.key]?.val).toEqual(['deferred', 'extra'])
    await handle.dispose()
  })

  it('preserves discovery through a real JSONL resume and a loop-created fork', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-progressive-resume-'))
    const h = await setup({}, root)
    try {
      h.ctx.tools.register(tool('deferred'))
      const adapter = new ScriptedLlm([
        response([{ name: 'tool_search', args: { query: 'deferred' } }]), response(),
        response([{ name: 'deferred', args: {} }]), response(),
      ])
      h.ctx.llm.registerAdapter(['scripted'], adapter)
      const first = await h.create('resume-parent')
      await run(h.ctx, first.agent)
      const events = first.agent.session.snapshotEvents()
      const fork = await h.ctx.agents.create({
        sessionId: SessionId('resume-fork'), seed: events,
        inheritedEventCount: SessionLogOffset(events.length),
        meta: { isSeeded: true, parentSession: first.agent.id },
        setup: (_agentCtx, agent) => { bindScopeParent(agent, h.key) },
      })
      expect(await schemas(h.ctx, fork.agent)).toEqual(['deferred', 'tool_search'])
      await fork.dispose()
      await first.dispose()
      const resumed = await h.ctx.agents.resume({
        resumeSessionId: SessionId('resume-parent'),
        agentOptions: { provider: 'scripted', model: 'scripted' },
        setup: (_agentCtx, agent) => { bindScopeParent(agent, h.key) },
      })
      expect(await schemas(h.ctx, resumed.agent)).toEqual(['deferred', 'tool_search'])
      await run(h.ctx, resumed.agent)
      expect(adapter.requests[2]?.tools?.map(tool => tool.name)).toEqual(['deferred', 'tool_search'])
      const outcome = resumed.agent.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)
      expect(outcome).toMatchObject({ data: { message: { isError: false, content: [{ type: 'text', text: 'deferred' }] } } })
      await resumed.dispose()
    } finally {
      await h.ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('validates eager referents without confusing conditions, restrictions, or later unload with a typo', async () => {
    const h = await setup({ eagerTools: ['conditional'] })
    const remove = h.ctx.tools.register(tool('conditional'), { when: () => false })
    const { agent } = await h.create('eager-ref')
    const restriction = agent.ctx.tools.restrict({ deny: ['conditional'] })
    expect(await schemas(h.ctx, agent)).toEqual(['tool_search'])
    restriction()
    remove()
    expect(await schemas(h.ctx, agent)).toEqual(['tool_search'])
    const invalid = await setup({ eagerTools: ['typo'] })
    const misspelled = (await invalid.create('bad-eager')).agent
    await expect(schemas(invalid.ctx, misspelled)).rejects.toThrow('eagerTools names unregistered tools: typo')
  })

  it('ignores failed, malformed, and duplicate activation metadata without replacing unchanged state', () => {
    const session = Session.create(SessionId('fold'))
    const fold = (meta: { progressiveToolActivation?: string[] | number[] }, isError = false) => session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: ToolCallId('fold'), content: [], isError }),
      meta,
    }, { surfaceOp: 'append' })
    const state: string[] = []
    expect(activationProjection.apply(state, fold({}))).toBe(state)
    expect(activationProjection.apply(state, fold({ progressiveToolActivation: [42] }))).toBe(state)
    expect(activationProjection.apply(state, fold({ progressiveToolActivation: ['x'] }, true))).toBe(state)
    const activated = activationProjection.apply(state, fold({ progressiveToolActivation: ['x'] }))
    expect(activationProjection.apply(activated, fold({ progressiveToolActivation: ['x'] }))).toBe(activated)
  })
})
