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
import { call, response, run, schemas, ScriptedLlm, services, setup, tool } from './fixtures.ts'

async function discover(h: Awaited<ReturnType<typeof setup>>, agent: Parameters<typeof call>[1], query = 'deferred') {
  return call(h.ctx, agent, 'tool_search', { query })
}

describe('progressive tool discovery on DSH 0.2.1', () => {
  it('requires explicit eager names and validates discovery limits', () => {
    expect(activationProjection.key).toBe('elves-ai/dsh-pi-mode/activation')
    expect(() => Config({} as never)).toThrow()
    expect(Config({ eagerTools: [] })).toEqual({ eagerTools: [], maxSearchResults: 5, descriptionMaxLength: 160 })
    for (const key of ['maxSearchResults', 'descriptionMaxLength']) {
      expect(() => Config({ eagerTools: [], [key]: 0 })).toThrow()
    }
  })

  it('withholds schemas and admits discovered tools only after the next model assembly', async () => {
    const h = await setup({ eagerTools: ['read'] })
    let calls = 0
    h.ctx.tools.register(tool('read'))
    h.ctx.tools.register(tool('deferred', 'Deferred useful capability.', async () => { calls++; return 'worked' }))
    const { agent } = await h.create('first')
    expect(await schemas(h.ctx, agent)).toEqual(['read', 'tool_search'])
    expect(await call(h.ctx, agent, 'deferred')).toMatchObject({
      isError: true, error: { message: expect.stringContaining('tool_search first') },
    })
    const search = await discover(h, agent)
    expect(search).toMatchObject({
      isError: false,
      value: [{ name: 'deferred', description: 'Deferred useful capability.' }],
      meta: { progressiveToolActivation: ['deferred'] },
    })
    expect(JSON.stringify(search)).not.toContain('parameters')
    expect((await call(h.ctx, agent, 'deferred')).isError).toBe(true)
    expect(calls).toBe(0)
    expect(await schemas(h.ctx, agent)).toEqual(['deferred', 'read', 'tool_search'])
    expect((await call(h.ctx, agent, 'deferred')).isError).toBe(false)
    expect(calls).toBe(1)
  })

  it('does not activate unlogged searches, invalid queries, blocked or cancelled results', async () => {
    const h = await setup()
    h.ctx.tools.register(tool('deferred'))
    const { agent } = await h.create('no-commit')
    await call(h.ctx, agent, 'tool_search', { query: 'deferred' }, { log: false })
    expect(await schemas(h.ctx, agent)).toEqual(['tool_search'])
    for (const query of ['', '!!!']) expect((await discover(h, agent, query)).isError).toBe(true)
    const block = agent.ctx.on('tools/post-execute', async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'blocked' }] }))
    expect((await discover(h, agent)).isError).toBe(true)
    block()
    const controller = new AbortController()
    const cancel = agent.ctx.on('tools/post-execute', (_exec, _result, next) => { controller.abort(); return next() })
    expect((await call(h.ctx, agent, 'tool_search', { query: 'deferred' }, { signal: controller.signal })).isError).toBe(true)
    cancel()
    expect(await schemas(h.ctx, agent)).toEqual(['tool_search'])
  })

  it.each([1, 4])('freezes admission across a real response at Host concurrency %i, including diagnostic assembly', async (concurrency) => {
    const h = await setup({}, undefined, concurrency)
    let calls = 0
    h.ctx.tools.register(tool('deferred', 'Deferred capability.', async () => { calls++; return 'ran' }))
    const { agent } = await h.create(`same-response-${concurrency}`)
    agent.ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'deferred') await h.ctx.systemPrompt.assemble({ scope: agent, agent })
      return next()
    })
    const adapter = new ScriptedLlm([
      response([
        { name: 'tool_search', args: { query: 'deferred' } },
        { name: 'deferred', args: {} },
        { name: 'tool_search', args: { query: 'deferred' } },
        { name: 'deferred', args: {} },
      ]),
      response([{ name: 'deferred', args: {} }]), response(),
    ])
    h.ctx.llm.registerAdapter(['scripted'], adapter)
    await run(h.ctx, agent)
    const results = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results.map(event => event.data.message.isError)).toEqual([false, true, false, true, false])
    expect(calls).toBe(1)
    expect(adapter.requests.map(request => request.tools?.map(tool => tool.name))).toEqual([
      ['tool_search'], ['deferred', 'tool_search'], ['deferred', 'tool_search'],
    ])
  })

  it('bounds deterministic search results without returning schemas', async () => {
    const h = await setup({ maxSearchResults: 2, descriptionMaxLength: 3 })
    h.ctx.tools.register(tool('b_lookup', '🔍📚😀long'))
    h.ctx.tools.register(tool('a_lookup', '🔍📚😀long'))
    h.ctx.tools.register(tool('c_lookup', 'lookup description'))
    h.ctx.tools.register(tool('d_lookup', '🔍📚😀long'))
    const { agent } = await h.create('bounds')
    expect(await discover(h, agent, 'lookup')).toMatchObject({ value: [
      { name: 'c_lookup', description: 'lo…' }, { name: 'a_lookup', description: '🔍📚…' },
    ] })
    expect(await schemas(h.ctx, agent)).toEqual(['a_lookup', 'c_lookup', 'tool_search'])
    expect(await discover(h, agent, 'missing')).toMatchObject({ isError: false, value: [] })
  })

  it.each<[number, string]>([
    [1, '…'], [2, '🔍…'], [3, '🔍📚😀'], [4, '🔍📚😀'],
  ])('keeps truncation within a %i-code-point description limit', async (descriptionMaxLength, expected) => {
    const h = await setup({ descriptionMaxLength })
    h.ctx.tools.register(tool('unicode', '🔍📚😀'))
    const { agent } = await h.create(`unicode-${descriptionMaxLength}`)
    expect(await discover(h, agent, 'unicode')).toMatchObject({ value: [{ name: 'unicode', description: expected }] })
  })

  it('discovers later matching tools with repeated searches and excludes eager tools', async () => {
    const h = await setup({ eagerTools: ['read'] })
    h.ctx.tools.register(tool('read', 'lookup files'))
    for (let index = 0; index < 7; index++) h.ctx.tools.register(tool(`lookup_${index}`, 'lookup task'))
    const { agent } = await h.create('next-matches')
    expect(await discover(h, agent, 'lookup')).toMatchObject({
      value: Array.from({ length: 5 }, (_, index) => ({ name: `lookup_${index}`, description: 'lookup task' })),
    })
    expect(await discover(h, agent, 'lookup')).toMatchObject({ value: [
      { name: 'lookup_5', description: 'lookup task' }, { name: 'lookup_6', description: 'lookup task' },
    ] })
    expect(await discover(h, agent, 'lookup')).toMatchObject({ value: [] })
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
    expect(await discover(h, b, 'private')).toMatchObject({ value: [] })
    const foreign = await h.ctx.agents.create({ sessionId: SessionId('foreign') })
    expect(await schemas(h.ctx, foreign.agent)).toEqual(['deferred'])
    expect(h.ctx.tools.get('tool_search', foreign.agent)).toBeUndefined()
  })

  it('retains restrictions, monotonic guards, and unload after discovery', async () => {
    const h = await setup()
    const remove = h.ctx.tools.register(tool('deferred'))
    const { agent } = await h.create('restricted')
    const deny = agent.ctx.tools.restrict({ deny: ['deferred'] })
    expect(await discover(h, agent)).toMatchObject({ value: [] })
    expect(await schemas(h.ctx, agent)).toEqual(['tool_search'])
    deny()
    await discover(h, agent)
    expect(await schemas(h.ctx, agent)).toContain('deferred')
    const guard = agent.ctx.tools.guard(() => 'guard denied')
    const allow = agent.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    expect(await call(h.ctx, agent, 'deferred')).toMatchObject({ isError: true, error: { message: 'guard denied' } })
    guard()
    expect((await call(h.ctx, agent, 'deferred')).isError).toBe(false)
    const restriction = agent.ctx.tools.restrict({ deny: ['deferred'] })
    expect((await call(h.ctx, agent, 'deferred')).isError).toBe(true)
    expect(await schemas(h.ctx, agent)).toEqual(['tool_search'])
    restriction()
    remove()
    expect((await call(h.ctx, agent, 'deferred')).isError).toBe(true)
    expect(await discover(h, agent)).toMatchObject({ value: [] })
    allow()
  })

  it('releases owned registrations and restores live Agents on reload', async () => {
    const h = await setup()
    h.ctx.tools.register(tool('deferred'))
    const first = await h.create('hmr-a')
    const second = await h.create('hmr-b')
    const foreign = await h.ctx.agents.create({ sessionId: SessionId('hmr-foreign') })
    expect((await h.ctx.systemPrompt.assemble({ scope: h.key })).tools.map(tool => tool.name)).toEqual(['tool_search'])
    await discover(h, first.agent)
    await h.fiber.dispose()
    expect(h.ctx.tools.get('tool_search', first.agent)).toBeUndefined()
    expect(await schemas(h.ctx, second.agent)).toEqual(['deferred'])
    const replacement = h.preset.ctx.plugin(Progressive, h.options)
    await replacement
    expect((await call(h.ctx, first.agent, 'deferred')).isError).toBe(true)
    expect(await schemas(h.ctx, first.agent)).toEqual(['deferred', 'tool_search'])
    expect(await schemas(h.ctx, second.agent)).toEqual(['tool_search'])
    expect(await schemas(h.ctx, foreign.agent)).toEqual(['deferred'])
    await first.dispose()
    await replacement.dispose()
    await h.preset.ctx.plugin(Progressive, h.options)
    expect(await schemas(h.ctx, second.agent)).toEqual(['tool_search'])
    await second.dispose()
    await foreign.dispose()
  })

  it('cleans effects when unloaded while activation is pending', async () => {
    const h = await setup()
    const { agent } = await h.create('early-dispose')
    await h.fiber.dispose()
    const loading = h.preset.ctx.plugin(Progressive, h.options)
    await loading.dispose()
    expect(h.ctx.tools.get('tool_search', agent)).toBeUndefined()
    expect(await schemas(h.ctx, agent)).toEqual([])
    await h.preset.ctx.plugin(Progressive, h.options)
    expect(await schemas(h.ctx, agent)).toEqual(['tool_search'])
  })

  it('covers existing Agents when mounted at deployment scope', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await services(ctx)
    const handle = await ctx.agents.create({ sessionId: SessionId('existing-root') })
    await ctx.plugin(Progressive, { eagerTools: [] })
    expect(await schemas(ctx, handle.agent)).toEqual(['tool_search'])
    await handle.dispose()
  })

  it('fails activation on conflicting projection registration', async () => {
    const h = await setup()
    await h.fiber.dispose()
    const dispose = h.ctx.sessionProjections.register({ ...activationProjection, stateVersion: 99 })
    await expect(h.preset.ctx.plugin(Progressive, h.options)).rejects.toThrow()
    expect(h.ctx.tools.get('tool_search', h.key)).toBeUndefined()
    dispose()
  })

  it('replays activation on reconstructed and forked Sessions and restores checkpoints', async () => {
    const h = await setup()
    h.ctx.tools.register(tool('deferred'))
    const { agent } = await h.create('history')
    await discover(h, agent)
    const events = agent.session.snapshotEvents()
    const restored = Session.create(SessionId('restored'), events)
    const forked = Session.create(SessionId('forked'), events,
      { ...agent.session.header, id: SessionId('forked'), isSeeded: true }, SessionLogOffset(events.length))
    expect(h.ctx.sessionProjections.stateOf(restored, activationProjection.key)).toEqual(['deferred'])
    expect(h.ctx.sessionProjections.stateOf(forked, activationProjection.key)).toEqual(['deferred'])
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
    const replayed = h.ctx.sessionProjections.restore(checkpoint, agent.session.snapshotEvents(floor), floor, restored.header, SessionLogOffset(0))
    expect(replayed.checkpoint[activationProjection.key]?.val).toEqual(['deferred', 'extra'])
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
      expect(resumed.agent.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1))
        .toMatchObject({ data: { message: { isError: false, content: [{ type: 'text', text: 'deferred' }] } } })
      await resumed.dispose()
    } finally {
      await h.ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('validates eager referents without treating restrictions or later unload as a typo', async () => {
    const h = await setup({ eagerTools: ['read'] })
    const remove = h.ctx.tools.register(tool('read'))
    const { agent } = await h.create('eager-ref')
    const restriction = agent.ctx.tools.restrict({ deny: ['read'] })
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
      message: createToolResultMessage({ callId: ToolCallId('fold'), content: [], isError }), meta,
    }, { surfaceOp: 'append' })
    const state: string[] = []
    expect(activationProjection.apply(state, fold({}))).toBe(state)
    expect(activationProjection.apply(state, fold({ progressiveToolActivation: [42] }))).toBe(state)
    expect(activationProjection.apply(state, fold({ progressiveToolActivation: ['x'] }, true))).toBe(state)
    const activated = activationProjection.apply(state, fold({ progressiveToolActivation: ['x'] }))
    expect(activationProjection.apply(activated, fold({ progressiveToolActivation: ['x'] }))).toBe(activated)
  })
})
