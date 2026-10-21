import { describe, expect, it } from 'vitest'
import { deferredSections } from '../components/item-edit/lazy-sections'
import type { ActiveLayoutData } from '../components/item-edit/types'
import {
  activeFreeze,
  activeWindowPatch,
  freezePatch,
  lazySectionPatch,
  lazySectionsOf,
  phoneOfPatch,
  windowState
} from './layout-resolve'

describe('layout resolve settings', () => {
  it('keeps every other conditions key when one changes', () => {
    const base = { role_ids: ['R'], testing: { records: [] } }
    const p = activeWindowPatch(base, { from: '2026-12-15', until: null })
    expect(p.conditions).toEqual({ ...base, active_window: { from: '2026-12-15' } })
    expect(activeWindowPatch(p.conditions, { from: null, until: null }).conditions).toEqual(base)
    expect(phoneOfPatch(null, 4).conditions).toEqual({ phone_of: 4 })
    expect(phoneOfPatch({ phone_of: 4 }, null).conditions).toBeNull()
  })

  it('reads windows and freezes from stored text', () => {
    expect(windowState({ from: '2026-12-15', until: null }, '2026-12-14')).toBe('before')
    const f = freezePatch(null, { until: '2026-11-01', reason: 'Go-live' }).conditions
    expect(activeFreeze(JSON.stringify(f), '2026-10-31')?.reason).toBe('Go-live')
    expect(activeFreeze(f, '2026-11-01')).toBeNull()
  })

  it('toggles a lazy section by key', () => {
    const on = lazySectionPatch(null, 'lines', true).conditions
    expect(lazySectionsOf(on)).toEqual(['lines'])
    expect(lazySectionPatch(on, 'lines', false).conditions).toBeNull()
  })
})

describe('deferredSections (#2713)', () => {
  const layout = (conditions: unknown, collapsed = true): ActiveLayoutData =>
    ({
      layout: { id: 1, name: 'F', conditions } as never,
      groups: [
        { id: 1, key: 'main', type: 'section', is_collapsed: false, sort: 0 },
        {
          id: 2,
          key: 'lines',
          type: 'section',
          is_collapsed: collapsed,
          sort: 1,
          summary_fields: JSON.stringify(['total'])
        }
      ] as never,
      assignments: [
        { field: 'title', group_key: 'main', sort: 0, is_visible: 1 },
        { field: 'lines', group_key: 'lines', sort: 0, is_visible: 1 },
        { field: 'total', group_key: 'lines', sort: 1, is_visible: 1 },
        { field: 'title', group_key: 'lines', sort: 2, is_visible: 1 }
      ]
    }) as ActiveLayoutData

  it('defers the fields only a folded lazy section holds, not its summary', () => {
    const d = deferredSections(layout({ lazy_sections: ['lines'] }), new Set())
    expect([...d.groups]).toEqual(['lines'])
    expect([...d.fields]).toEqual(['lines'])
  })

  it('defers nothing once opened, when not folded, off, or on the design canvas', () => {
    const lazy = { lazy_sections: ['lines'] }
    expect(deferredSections(layout(lazy), new Set(['lines'])).groups.size).toBe(0)
    expect(deferredSections(layout(lazy, false), new Set()).groups.size).toBe(0)
    expect(deferredSections(layout(null), new Set()).groups.size).toBe(0)
    expect(deferredSections(layout(lazy), new Set(), { design: true }).groups.size).toBe(0)
  })
})
