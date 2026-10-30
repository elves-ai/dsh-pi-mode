import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

const manifest: object = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('DSH 0.2.1 API compatibility', () => {
  it.each(['0.2.1-rc.5', '0.2.1-rc.6', '0.2.1'])('admits %s through the Host compatibility check', version => {
    expect(evaluatePluginCompatibility(manifest, {}, version)).toBeUndefined()
  })

  it.each(['0.1.99', '0.2.0-rc.1', '0.2.0', '0.2.1-rc.4', '0.2.2-alpha.2', '0.2.2', '1.0.0'])(
    'rejects unsupported API version %s', version => {
      expect(evaluatePluginCompatibility(manifest, {}, version)).toMatchObject({
        requirements: { 'engines.dsh': '>=0.2.1-rc.5 <0.2.2-0' },
        exempted: false,
      })
    },
  )
})
