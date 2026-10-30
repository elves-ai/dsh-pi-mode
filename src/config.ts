/** Validated discovery and scheduling configuration. @module */
import z from '@deepseek-ai/schemastery'

/** Exact eager names and bounded discovery output. */
export interface Config {
  /** Tools declared without a preceding search; an empty list is permitted. */
  eagerTools: string[]
  /** Maximum matches returned and activated by one search. */
  maxSearchResults: number
  /** Maximum Unicode code points per returned description. */
  descriptionMaxLength: number
  /** Maximum overlapping concurrency-safe root calls unless the batch overrides it. */
  maxParallelToolCalls: number
}

/** Required eager names and positive discovery and scheduling limits. */
export const Config: z<Pick<Config, 'eagerTools'> & Partial<Omit<Config, 'eagerTools'>>, Config> = z.object({
  eagerTools: z.array(z.string().min(1)).required(),
  maxSearchResults: z.natural().min(1).default(5),
  descriptionMaxLength: z.natural().min(1).default(160),
  maxParallelToolCalls: z.natural().min(1).default(10),
})
