import { describe, expect, it } from 'vitest'
import {
  changedWidgetIds,
  configAgoText,
  configBaseRevHeaders,
  configChangeText,
  diffConfigFields,
  foldConfigChange,
  isConfigStale
} from './config-watch'

describe('config watch (rt4 #14 / #18)', () => {
  it('folds pokes: same person and part stay, a mix reads as several', () => {
    const a = foldConfigChange(null, { part: 'state', by: { id: 'b', name: 'Beth' } }, 1000)
    expect(a).toEqual({ by: { id: 'b', name: 'Beth' }, part: 'state', at: 1000, count: 1 })
    const b = foldConfigChange(a, { part: 'state', by: { id: 'B', name: 'Beth' } }, 2000)
    expect(b).toMatchObject({ part: 'state', count: 2, by: { name: 'Beth' } })
    const c = foldConfigChange(b, { part: 'owners', by: { id: 'k', name: 'Kim' } }, 3000)
    expect(c).toMatchObject({ part: 'several', by: null, count: 3, at: 3000 })
  })

  it('reads as a sentence', () => {
    const one = { by: { id: 'b', name: 'Beth' }, part: 'state', at: 0, count: 1 }
    expect(configChangeText(one, 10_000)).toBe('Beth changed a state just now')
    expect(configChangeText({ ...one, part: 'step' }, 70_000)).toBe('Beth changed a step 1 min ago')
    expect(configChangeText({ ...one, count: 3 }, 0)).toBe('Beth made changes just now')
    expect(configChangeText({ ...one, by: null, part: 'version' }, 0)).toBe(
      'Someone restored an earlier version just now'
    )
    expect(configAgoText(0, 2 * 3_600_000)).toBe('2 h ago')
  })

  it('only widgets whose definition changed read their figures again', () => {
    const before = [
      { id: 'a', type: 'count', collection: 'x', col: 0, row: 0 },
      { id: 'b', type: 'count', collection: 'x', filters: { s: 1 }, col: 1, row: 0 },
      { id: 'c', type: 'list', collection: 'y', x: 0, y: 2 }
    ]
    const after = [
      { id: 'a', type: 'count', collection: 'x', col: 4, row: 3 }, // moved
      { id: 'b', type: 'count', collection: 'x', filters: { s: 2 }, col: 1, row: 0 }, // changed
      { id: 'c', type: 'list', collection: 'y', x: 0, y: 2, w: 6 }, // resized
      { id: 'd', type: 'list', collection: 'z' } // new
    ]
    expect(changedWidgetIds(before, after)).toEqual(['b'])
    expect(changedWidgetIds(null, after)).toEqual([])
  })

  it('base revision header and the stale refusal', () => {
    expect(configBaseRevHeaders(null)).toEqual({})
    expect(configBaseRevHeaders('2026-11-14T10:00:00.123Z')).toEqual({
      'x-nivaro-base-rev': '2026-11-14T10:00:00.123Z'
    })
    expect(isConfigStale({ response: { status: 409, data: { code: 'CONFIG_STALE' } } })).toBe(true)
    expect(isConfigStale({ status: 409, response: { code: 'CONFIG_STALE' } })).toBe(true)
    expect(isConfigStale({ response: { status: 409, data: { code: 'PROC_STALE' } } })).toBe(false)
    expect(isConfigStale(null)).toBe(false)
  })

  it('lists only the fields where their saved copy differs from the form', () => {
    const rows = diffConfigFields(
      { name: 'Mine', enabled: true, headers: [{ key: 'a', value: '1' }], note: '' },
      { name: 'Theirs', enabled: true, headers: [{ key: 'a', value: '2' }], note: null },
      { name: 'Name', enabled: 'Enabled', headers: 'Headers', note: 'Note' }
    )
    expect(rows.map((r) => r.key)).toEqual(['name', 'headers'])
    expect(rows[0]).toEqual({
      key: 'name',
      label: 'Name',
      theirs: 'Theirs',
      mine: 'Mine',
      code: false
    })
    expect(rows[1].theirs).toBe('[{"key":"a","value":"2"}]')
    expect(rows[1].code).toBe(true)
    expect(
      diffConfigFields({ u: 'https://a.example/x' }, { u: 'https://b.example/x' }, { u: 'URL' })[0]
        .code
    ).toBe(true)
  })
})
