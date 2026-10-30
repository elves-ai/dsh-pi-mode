/** Bounded keyword discovery over the caller's scope-visible registry. @module */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool, ToolArgsError, type ToolDefinition, type ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { Config } from './config.ts'

/**
 * Build the mounting scope's search tool; the execution supplies its exact Agent.
 * @param tools - retained registry used for scoped, live lookup.
 * @param config - eager names, result count, and description limits.
 * @param activatedNames - reads committed activation names for the caller; no Agent means no session activation.
 * @returns a registry-ready tool returning only names and short descriptions.
 */
export function createSearchTool(
  tools: ToolRuntime, config: Config, activatedNames: (agent: Agent | undefined) => readonly string[],
): ToolDefinition {
  const eager = new Set(['tool_search', ...config.eagerTools])
  return defineTool({
    name: 'tool_search',
    description: 'Find additional, not yet loaded tools by name or description keywords. Returns names and short descriptions, not parameter schemas. Matching tools become callable in your next response, after their schemas are available; do not call newly found tools in this response. Repeat a query to discover more matches.',
    parameters: {
      query: { type: 'string', required: true, description: 'Non-empty keywords describing the tool or task.' },
    },
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            name: { type: 'string', required: true },
            description: { type: 'string', required: true },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ progressiveToolActivation: value.map(tool => tool.name) }),
    },
    isConcurrencySafe: () => true,
    execute({ query }, exec) {
      const tokens = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean))]
      if (tokens.length === 0) throw new ToolArgsError(['query must contain a keyword'])
      const active = new Set([...eager, ...activatedNames(exec.agent)])
      const candidates = tools.schemas(exec.agent)
        .filter(tool => !active.has(tool.name) && tools.get(tool.name, exec.agent) !== undefined)
        .map(tool => ({
          tool,
          score: tokens.reduce((score, token) => score
            + (tool.name.toLowerCase().includes(token) ? 2 : 0)
            + (tool.description.toLowerCase().includes(token) ? 1 : 0), 0),
        }))
        .filter(match => match.score > 0)
        .sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : 1))
      return Promise.resolve(candidates.slice(0, config.maxSearchResults).map(({ tool }) => {
        const characters = Array.from(tool.description)
        return {
          name: tool.name,
          description: characters.length > config.descriptionMaxLength
            ? characters.slice(0, config.descriptionMaxLength - 1).join('') + '…'
            : tool.description,
        }
      }))
    },
  })
}
