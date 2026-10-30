import assert from 'node:assert/strict'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const inject = ['agents', 'agentPresets', 'tools', 'systemPrompt', 'llm', 'userQuestions']

export function apply(ctx) {
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  if (!ready || !exit) throw new Error('This test probe must run through the dsh CLI')
  ctx.on('user-questions/request', async () => ({ answers: [{ id: 'go', selected: ['Continue'] }] }))
  ctx.effect(() => ready.onReady(async () => {
    try {
      const requests = []
      const calls = [
        { name: 'ask_user_question', args: { questions: [{ id: 'go', question: 'Continue?', options: [{ label: 'Continue' }] }] } },
        { name: 'tool_search', args: { query: 'glob' } },
        { name: 'glob', args: { pattern: 'needle.txt' } },
      ]
      class ScriptedModel extends LlmAdapter {
        async resolveModel(provider, model) {
          return { provider, id: model, name: model, context: { contextWindow: 128000 } }
        }
        async * stream(options) {
          if (options.purpose !== undefined) {
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Pi smoke' } }
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          }
          requests.push(options)
          const call = calls[requests.length - 1]
          yield { type: 'block-start', index: 0, blockType: call ? 'tool-call' : 'text' }
          yield { type: 'block-end', index: 0, block: call
            ? { type: 'tool-call', id: ToolCallId(`smoke-${requests.length}`), name: call.name, arguments: JSON.stringify(call.args) }
            : { type: 'text', text: 'PI_SMOKE_DONE' } }
          yield { type: 'finish', reason: { kind: call ? 'tool-calls' : 'stop' } }
        }
      }
      const roster = await ctx.agentPresets.list()
      assert.equal(roster.find(preset => preset.id === 'pi-mode')?.broken, undefined)
      assert(roster.some(preset => preset.id === 'pi-mode'))
      ctx.llm.registerAdapter(['pi-smoke'], new ScriptedModel())
      const handle = await ctx.agents.create({
        sessionId: SessionId('pi-distribution-smoke'), meta: { cwd: process.cwd() },
        agentOptions: { provider: 'pi-smoke', model: 'pi-smoke' },
        setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'pi-mode') },
      })
      try {
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Run the distribution smoke script.' }], source: { kind: 'user' } }))
        await handle.agent.whenIdle()
        assert.equal(requests.length, 4)
        const initial = requests[0].tools.map(tool => tool.name)
        assert.equal(initial.length, 9)
        assert(initial.includes('ask_user_question'))
        assert(!initial.includes('glob'))
        const answer = requests[1].messages.find(message => message.role === 'tool' && message.toolCallId === 'smoke-1')
        assert(answer, JSON.stringify({
          tools: requests[1].messages.filter(message => message.role === 'tool'),
          outcomes: handle.agent.session.snapshotEvents().filter(event => event.type === 'tool/result'),
        }))
        assert.deepEqual(answer.content, [{ type: 'text', text: '{"answers":[{"id":"go","selected":["Continue"]}]}' }])
        assert(requests[2].tools.some(tool => tool.name === 'glob'))
        const results = handle.agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
        assert.equal(results.length, 3)
        assert(results.every(event => !event.data.message.isError))
        assert(JSON.stringify(results.at(-1)).includes('needle.txt'))
        console.info('PI_MODE_DISTRIBUTION_SMOKE ' + JSON.stringify({ initial, requests: requests.length, question: true, discovery: true, executed: true }))
      } finally {
        await handle.dispose()
      }
      exit(0)
    } catch (error) {
      console.error(error)
      exit(1)
    }
  }, 'Pi distribution smoke'))
}
