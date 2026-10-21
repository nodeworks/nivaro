import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { normalizeEntryConfig, parseEntryConfig } from '../../../services/layout-entry.js'

const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../../packages/shared/src/lib/entry-config.fixtures.json', import.meta.url)
    ),
    'utf8'
  )
) as Array<{ name: string; in: unknown; out: unknown }>

describe('layout entry config (#2702 #2707 #2708 #2710 #2728)', () => {
  for (const c of fixtures)
    it(`sanitizes like the client: ${c.name}`, () => {
      expect(parseEntryConfig(c.in)).toEqual(c.out)
    })

  it('stores clean JSON text, null when nothing is set', () => {
    expect(normalizeEntryConfig(null)).toEqual({ value: null })
    expect(normalizeEntryConfig({ adaptive: false })).toEqual({ value: null })
    expect(normalizeEntryConfig({ enter_next: true, junk: 1 })).toEqual({
      value: '{"enter_next":true}'
    })
  })

  it('refuses what is no object', () => {
    expect(normalizeEntryConfig('x')).toHaveProperty('error')
    expect(normalizeEntryConfig([1])).toHaveProperty('error')
  })
})
