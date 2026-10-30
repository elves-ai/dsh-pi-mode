/** Successful search result metadata is the sole durable activation source. @module */
import { z } from 'zod';
const activationMeta = z.object({ progressiveToolActivation: z.array(z.string()) });
/** Host-only unique names; unrelated results preserve the state reference. */
export const activationProjection = {
    key: 'elves-ai/dsh-pi-mode/activation',
    stateVersion: 1,
    stateSchema: z.array(z.string()),
    init: () => [],
    apply(state, event) {
        if (event.type !== 'tool/result' || event.data.message.isError)
            return state;
        const parsed = activationMeta.safeParse(event.data.meta);
        if (!parsed.success)
            return state;
        const names = new Set(state);
        for (const name of parsed.data.progressiveToolActivation)
            names.add(name);
        return names.size === state.length ? state : [...names].sort();
    },
};
