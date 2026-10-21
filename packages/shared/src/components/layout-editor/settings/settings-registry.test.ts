import { describe, expect, it } from 'vitest'
import {
  layoutKindOf,
  matchesQuery,
  SECTIONS,
  SETTINGS,
  settingDef,
  visibleSections
} from './settings-registry'

interface ParityRow {
  key: string
  home: string | null
  tab_or_section: string | null
  status: string
  layout_types: string[]
}

// Same loading as parity-keys.test.ts (a static JSON import trips TS6307).
const PARITY_JSON = '../parity-keys.json'
const rows = (await import(/* @vite-ignore */ PARITY_JSON)).default as ParityRow[]
const formRows = rows.filter((r) => r.home === 'form_settings' && r.status !== 'retired')
const retired = rows.filter((r) => r.status === 'retired').map((r) => r.key)

describe('form settings registry', () => {
  it('has one entry per form settings parity row, in the same section and types', () => {
    expect(SETTINGS.map((s) => s.key).sort()).toEqual(formRows.map((r) => r.key).sort())
    for (const r of formRows) {
      const def = settingDef(r.key)
      const section = SECTIONS.find((s) => s.id === def?.section)
      expect(section?.title, r.key).toBe(r.tab_or_section)
      expect([...(def?.types ?? [])].sort(), r.key).toEqual([...r.layout_types].sort())
    }
  })

  it('offers no retired setting', () => {
    for (const key of retired) expect(settingDef(key), key).toBeUndefined()
  })

  it('gives every setting a label and a one-sentence effect', () => {
    for (const s of SETTINGS) {
      expect(s.label.trim(), s.key).not.toBe('')
      expect(s.effect.trim(), s.key).toMatch(/[.”]$/)
    }
  })

  it('reads a missing or legacy layout_type as grouped', () => {
    expect(layoutKindOf({ layout_type: null })).toBe('grouped')
    expect(layoutKindOf({ layout_type: 'nonsense' })).toBe('grouped')
    expect(layoutKindOf({ layout_type: 'file' })).toBe('file')
  })

  it('matches a query against label, effect sentence and key, every word', () => {
    const logo = settingDef('layout.pdf_show_logo')
    if (!logo) throw new Error('missing')
    expect(matchesQuery(logo, 'LOGO')).toBe(true)
    expect(matchesQuery(logo, 'prints top')).toBe(true)
    expect(matchesQuery(logo, 'pdf_show')).toBe(true)
    expect(matchesQuery(logo, 'logo cover')).toBe(false)
  })

  it('gives addendum layouts every section that applies to them', () => {
    expect(visibleSections('addendum').map((s) => s.section.id)).toEqual([
      'who',
      'layout',
      'addendum',
      'defaults',
      'inheritance',
      'tools'
    ])
  })

  it('shows PDF settings only on file layouts', () => {
    expect(visibleSections('grouped').some((s) => s.section.id === 'pdf')).toBe(false)
    expect(visibleSections('file').some((s) => s.section.id === 'pdf')).toBe(true)
  })

  it('narrows sections to the matching settings', () => {
    const found = visibleSections('file', 'logo')
    expect(found.map((s) => s.section.id)).toEqual(['pdf'])
    expect(found[0].settings.map((s) => s.key)).toEqual(['layout.pdf_show_logo'])
    expect(visibleSections('grouped', 'zzz-nothing')).toEqual([])
  })
})
