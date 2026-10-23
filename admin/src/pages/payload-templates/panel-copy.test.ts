import { describe, expect, it } from 'vitest'
import type { TemplateDetail } from './api'
import { orderResults, summarize } from './CheckRecentPanel'
import { conflictText } from './ConflictPanel'
import { defaultCopy } from './DefaultPanel'
import { restoreCopy } from './HistoryPanel'
import { type CheckResult, draftLookupsOf, liveLookupsOf, sameLookups } from './panel-api'

const row = (over: Partial<TemplateDetail>): TemplateDetail =>
  ({ key: 'k', published_version: 7, ...over }) as TemplateDetail

describe('conflictText', () => {
  it('uses the exact banner copy with the publisher’s name', () => {
    expect(conflictText(row({ published_version: 8, published_by_name: 'Rob' }), row({}))).toBe(
      'Rob published v8 while you edited. Reload, or keep your draft and review the diff.'
    )
  })

  it('says "Someone" without a name, and names a draft save when nothing was published', () => {
    expect(conflictText(row({ published_version: 8 }), row({}))).toBe(
      'Someone published v8 while you edited. Reload, or keep your draft and review the diff.'
    )
    expect(conflictText(row({ draft_updated_by_name: 'Ana' }), row({}))).toBe(
      'Ana saved this draft while you edited. Reload, or keep your draft and review the diff.'
    )
  })
})

describe('restore / default copy', () => {
  it('says out loud when restoring switches the mode', () => {
    expect(restoreCopy(5, 'map', 'map')).toBe(
      'Your current draft — body and lookups — is replaced by v5. Nothing goes live until you publish.'
    )
    expect(restoreCopy(5, 'map', 'code')).toMatch(/switches back from Liquid to the field map/)
    expect(restoreCopy(5, 'code', 'map')).toMatch(/field map goes away/)
    expect(
      defaultCopy(
        'efp-ops',
        { mode: 'map', body: { v: 1, fields: [] } },
        { mode: 'code', body: '' }
      )
    ).toMatch(/switches back from Liquid to the field map/)
  })
})

describe('check results', () => {
  const r = (id: string, ok: boolean, skipped: string | null = null): CheckResult => ({
    id,
    label: id,
    ok,
    problems: [],
    skipped
  })

  it('lists failures first, then skipped, then passes', () => {
    const out = orderResults([r('a', true), r('b', true, 'gate'), r('c', false), r('d', true)])
    expect(out.map((x) => x.id)).toEqual(['c', 'b', 'a', 'd'])
    expect(summarize(out)).toEqual({ failed: 1, skipped: 1, passed: 2, total: 4 })
  })
})

describe('lookups on a template', () => {
  it('reads the draft lookups apart from the published ones; null and {} are the same', () => {
    const t = {
      lookups: '{"wh":{"collection":"warehouses"}}',
      draft_lookups: { region: { collection: 'regions' } }
    } as unknown as TemplateDetail
    expect(liveLookupsOf(t)).toEqual({ wh: { collection: 'warehouses' } })
    expect(draftLookupsOf(t)).toEqual({ region: { collection: 'regions' } })
    expect(sameLookups(liveLookupsOf(t), draftLookupsOf(t))).toBe(false)
    expect(sameLookups(null, {})).toBe(true)
    // An older server without draft_lookups: the draft mirrors the published ones.
    expect(draftLookupsOf({ lookups: null } as unknown as TemplateDetail)).toBeNull()
  })
})
