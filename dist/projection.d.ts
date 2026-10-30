import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
declare module '@deepseek-ai/dsh-session-projection' {
    interface SessionProjectionStateMap {
        /** Tool names activated by committed successful search results. */
        'elves-ai/dsh-pi-mode/activation': string[];
    }
}
/** Host-only unique names; unrelated results preserve the state reference. */
export declare const activationProjection: ProjectionDefinition<'elves-ai/dsh-pi-mode/activation', string[]>;
