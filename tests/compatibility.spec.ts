import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { evaluatePluginCompatibility } from '@deepseek-ai/dsh-app-boot'

const manifest: object = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

describe('minimum DSH version requirement', () => {
  it.each([
    '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0', '0.2.1-rc.5',
    '0.2.2-alpha.2', '0.3.0-alpha.1', '1.0.0',
  ])('admits %s through the Host compatibility check', version => {
    expect(evaluatePluginCompatibility(manifest, {}, version)).toBeUndefined()
  })

  it.each(['0.1.99', '0.2.0-alpha.99', '0.2.0-rc.0'])(
    'rejects %s below the minimum', version => {
      expect(evaluatePluginCompatibility(manifest, {}, version)).toMatchObject({
        requirements: { 'engines.dsh': '>=0.2.0-rc.1' },
        exempted: false,
      })
    },
  )
})
