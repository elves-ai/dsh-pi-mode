/** Successful search result metadata is the sole durable activation source. @module */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    /** Tool names activated by committed successful search results. */
    'elves-ai/dsh-pi-mode/activation': string[]
  }
}

const activationMeta = z.object({ progressiveToolActivation: z.array(z.string()) })

/** Host-only unique names; unrelated results preserve the state reference. */
export const activationProjection: ProjectionDefinition<'elves-ai/dsh-pi-mode/activation', string[]> = {
  key: 'elves-ai/dsh-pi-mode/activation',
  stateVersion: 1,
  stateSchema: z.array(z.string()),
  init: () => [],
  apply(state, event) {
    if (event.type !== 'tool/result' || event.data.message.isError) return state
    const parsed = activationMeta.safeParse(event.data.meta)
    if (!parsed.success) return state
    const names = new Set(state)
    for (const name of parsed.data.progressiveToolActivation) names.add(name)
    return names.size === state.length ? state : [...names].sort()
  },
}
