import { describe, expect, it } from 'vitest'
import {
  type ConfigAnswer,
  configReadAs,
  wantsPlainConfig,
  withConfigAnswer
} from './global-search-helpers'

const hit = (id: string, href: string) => ({ kind: 'flow', id, label: id, href, admin_href: href })

describe('plain-words config search (item 24)', () => {
  it('asks only for administrators, 3+ words, no scope or field filter', () => {
    expect(wantsPlainConfig('where is the Fusion push for IRs set up', true)).toBe(true)
    expect(wantsPlainConfig('where is the Fusion push for IRs set up', false)).toBe(false)
    expect(wantsPlainConfig('fusion push', true)).toBe(false)
    expect(wantsPlainConfig('wf: fusion push now', true)).toBe(false)
    expect(wantsPlainConfig('status:open fusion push', true)).toBe(false)
  })

  it('puts the answer first and keeps one hit per screen', () => {
    const answer: ConfigAnswer = {
      hits: [hit('A', '/flows/1'), hit('B', '/flows/2')],
      rewrite: null,
      ai: 'not_needed'
    }
    const out = withConfigAnswer({ config: [hit('C', '/flows/2'), hit('D', '/flows/3')] }, answer)
    expect(out?.config?.map((h) => h.id)).toEqual(['A', 'B', 'D'])
    expect(withConfigAnswer({ docs: [] }, { hits: [], rewrite: null, ai: 'off' })).toEqual({
      docs: []
    })
  })

  it('says how the AI read the question, only when it did', () => {
    const rewrite = {
      keywords: ['fusion', 'push'],
      kinds: ['flow'],
      collection: 'inventory_request'
    }
    expect(configReadAs({ hits: [], rewrite, ai: 'used' })).toBe(
      'Read as: fusion, push · flow · inventory request'
    )
    expect(configReadAs({ hits: [], rewrite, ai: 'off' })).toBeNull()
  })
})
