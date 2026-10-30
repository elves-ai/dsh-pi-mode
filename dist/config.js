/** Validated discovery and scheduling configuration. @module */
import z from '@deepseek-ai/schemastery';
/** Required eager names and positive discovery and scheduling limits. */
export const Config = z.object({
    eagerTools: z.array(z.string().min(1)).required(),
    maxSearchResults: z.natural().min(1).default(5),
    descriptionMaxLength: z.natural().min(1).default(160),
    maxParallelToolCalls: z.natural().min(1).default(10),
});
