import { describe, expect, it } from 'vitest'
import { attentionAnnouncement, attentionCount } from './announce'
import { countFailures, formatAge, freshness, STALE_AFTER_FAILURES } from './freshness'
import {
  arrangeBoard,
  boardSizeFor,
  effectiveLayout,
  layoutToSave,
  movePanel,
  movePanelTo,
  resolvePanels,
  setPanelVisible
} from './layout'
import { nextRegion } from './shell-hooks'
import { isTypingTarget, regionForIndex, shortcutFor } from './shortcuts'
import { boardMode, ccToken } from './theme'
import { EMPTY_URL_STATE, parseBoardUrl, writeBoardUrl } from './url-state'

describe('URL state (CC-19)', () => {
  const now = Date.parse('2026-10-30T15:00:00Z')

  it('round-trips every lens and keeps unrelated parameters', () => {
    const state = {
      region: '12',
      at: Date.parse('2026-10-30T14:10:00Z'),
      map: 'locations',
      peek: { collection: 'work_orders', id: 'WO:42' },
      tv: true
    }
    const search = writeBoardUrl('?utm=x&region=old', state)
    const q = new URLSearchParams(search)
    expect(q.get('utm')).toBe('x')
    expect(q.get('peek')).toBe('work_orders:WO:42')
    expect(parseBoardUrl(search, now)).toEqual(state)
  })

  it('writes nothing for an empty board and drops its own keys', () => {
    expect(writeBoardUrl('?region=1&tv=1&peek=a:1', EMPTY_URL_STATE)).toBe('')
    expect(writeBoardUrl('', EMPTY_URL_STATE)).toBe('')
  })

  it('ignores values it cannot trust', () => {
    const s = parseBoardUrl(
      '?region=a%20b&map=drop;table&peek=nocolon&tv=yes&at=2027-01-01T00:00:00Z',
      now
    )
    expect(s).toEqual(EMPTY_URL_STATE)
    // a rewind further back than the window opens live
    expect(parseBoardUrl('?at=2026-01-01T00:00:00Z', now).at).toBeNull()
    // epoch milliseconds are accepted too
    expect(parseBoardUrl(`?at=${now - 60_000}`, now).at).toBe(now - 60_000)
  })
})

describe('freshness (CC-21)', () => {
  const now = 1_000_000
  it('reads as a short live age', () => {
    expect(formatAge(500)).toBe('just now')
    expect(formatAge(6_000)).toBe('6s ago')
    expect(formatAge(4 * 60_000)).toBe('4m ago')
    expect(formatAge(2 * 3_600_000)).toBe('2h ago')
  })
  it('stays fresh through one failed poll and goes stale after two', () => {
    expect(freshness({ updatedAt: now - 6000, failures: 0, now })).toEqual({
      kind: 'fresh',
      label: 'Updated 6s ago'
    })
    expect(freshness({ updatedAt: now - 26_000, failures: 1, now }).kind).toBe('fresh')
    const stale = freshness({ updatedAt: now - 46_000, failures: STALE_AFTER_FAILURES, now })
    expect(stale.kind).toBe('stale')
    expect(stale.kind === 'stale' && stale.since).toBeTruthy()
  })
  it('loading until the first answer; failed when it never came', () => {
    expect(freshness({ updatedAt: null, failures: 0, now }).kind).toBe('loading')
    expect(freshness({ updatedAt: null, failures: 1, now }).kind).toBe('loading')
    expect(freshness({ updatedAt: null, failures: 2, now }).kind).toBe('failed')
  })
  it('counts failures since the last success', () => {
    expect(countFailures(5, 3)).toBe(2)
    expect(countFailures(3, 3)).toBe(0)
    expect(countFailures(1, 3)).toBe(0)
  })
})

describe('keyboard shortcuts (CC-25)', () => {
  const input = { tagName: 'INPUT', getAttribute: () => null } as unknown as EventTarget
  const div = { tagName: 'DIV', getAttribute: () => null } as unknown as EventTarget
  const combobox = { tagName: 'BUTTON', getAttribute: () => 'combobox' } as unknown as EventTarget
  const editable = {
    tagName: 'DIV',
    isContentEditable: true,
    getAttribute: () => null
  } as unknown as EventTarget

  it('maps single keys to board actions', () => {
    expect(shortcutFor({ key: 'f', target: div })).toEqual({ kind: 'fullscreen' })
    expect(shortcutFor({ key: 'T', target: div })).toEqual({ kind: 'tv' })
    expect(shortcutFor({ key: 'r', target: div })).toEqual({ kind: 'refresh' })
    expect(shortcutFor({ key: 'g', target: div })).toEqual({ kind: 'focus-region' })
    expect(shortcutFor({ key: '/', target: div })).toBeNull()
    expect(shortcutFor({ key: '?', target: div })).toEqual({ kind: 'help' })
    expect(shortcutFor({ key: '3', target: div })).toEqual({ kind: 'region', index: 3 })
    expect(shortcutFor({ key: 'Escape', target: div })).toEqual({ kind: 'escape' })
    expect(shortcutFor({ key: 'x', target: div })).toBeNull()
  })

  it('stays out of the way while typing and with modifiers', () => {
    for (const target of [input, combobox, editable]) {
      expect(isTypingTarget(target)).toBe(true)
      expect(shortcutFor({ key: 'r', target })).toBeNull()
      expect(shortcutFor({ key: '1', target })).toBeNull()
    }
    expect(shortcutFor({ key: 'r', metaKey: true, target: div })).toBeNull()
    expect(shortcutFor({ key: 'f', ctrlKey: true, target: div })).toBeNull()
    expect(shortcutFor({ key: 'f', defaultPrevented: true, target: div })).toBeNull()
    // Esc still closes the record panel from a field inside it
    expect(shortcutFor({ key: 'Escape', target: input })).toEqual({ kind: 'escape' })
  })

  it('number keys pick regions: 0 = everywhere, past the end = nothing', () => {
    const regions = [{ id: 'n' }, { id: 's' }]
    expect(regionForIndex(regions, 0)).toBeNull()
    expect(regionForIndex(regions, 2)).toBe('s')
    expect(regionForIndex(regions, 3)).toBeUndefined()
  })
})

describe('layout (CC-24 + placement)', () => {
  const known = ['map', 'attention', 'flow', 'people', 'feed']

  it('built-in order when nothing is saved', () => {
    expect(resolvePanels(known, null).map((p) => p.key)).toEqual(known)
  })

  it('saved order wins; panels new since the save keep their built-in place', () => {
    // 'flow' is new since the save: it lands right after its registry neighbour 'attention'.
    const r = resolvePanels(known, {
      order: ['people', 'feed', 'map', 'gone_panel', 'attention'],
      hidden: ['feed']
    })
    expect(r.map((p) => p.key)).toEqual(['people', 'feed', 'map', 'attention', 'flow'])
    expect(r.find((p) => p.key === 'feed')?.visible).toBe(false)
    // nothing before it saved either → first
    expect(resolvePanels(known, { order: ['flow'], hidden: [] }).map((p) => p.key)[0]).toBe('map')
  })

  it('a save keeps keys this build does not know', () => {
    const stored = { order: ['future', 'map'], hidden: ['future_hidden'] }
    let edited = resolvePanels(known, stored)
    edited = movePanel(edited, 'people', -1)
    edited = setPanelVisible(edited, 'feed', false)
    const saved = layoutToSave(edited, stored, known)
    expect(saved.order).toEqual(['map', 'attention', 'people', 'flow', 'feed', 'future'])
    expect(saved.hidden).toEqual(['feed', 'future_hidden'])
  })

  it('moves by drag target and refuses moves off the ends', () => {
    const list = resolvePanels(known, null)
    expect(movePanelTo(list, 'feed', 'map').map((p) => p.key)[0]).toBe('feed')
    expect(movePanel(list, 'map', -1)).toBe(list)
  })

  it('own layout beats the role default, which beats the built-in', () => {
    const own = { order: ['a'], hidden: [] }
    const role = { order: ['b'], hidden: [] }
    expect(effectiveLayout(own, role)).toBe(own)
    expect(effectiveLayout(null, role)).toBe(role)
    expect(effectiveLayout(null, null)).toBeNull()
  })

  const defs = [
    { key: 'map', area: 'main' as const },
    { key: 'attention', area: 'lead' as const },
    { key: 'flow', area: 'rail' as const },
    { key: 'workload', area: 'lead' as const },
    { key: 'people', area: 'rail' as const },
    { key: 'feed', area: 'bottom' as const }
  ]

  it('sizes: 375 phone, 1024 medium, 1440 wide, 1920 very wide', () => {
    expect(boardSizeFor(375)).toBe('phone')
    expect(boardSizeFor(1024)).toBe('medium')
    expect(boardSizeFor(1440)).toBe('wide')
    expect(boardSizeFor(1920)).toBe('xwide')
  })

  it('1440: map beside a rail that opens with Needs attention', () => {
    const a = arrangeBoard(defs, boardSizeFor(1440))
    expect(a.columns).toBe('two')
    expect(a.main.map((p) => p.key)).toEqual(['map'])
    expect(a.under.map((p) => p.key)).toEqual(['feed'])
    expect(a.rail.map((p) => p.key)).toEqual(['attention', 'flow', 'workload', 'people'])
  })

  it('1920: attention and workload get their own column', () => {
    const a = arrangeBoard(defs, boardSizeFor(1920))
    expect(a.columns).toBe('three')
    expect(a.lead.map((p) => p.key)).toEqual(['attention', 'workload'])
    expect(a.rail.map((p) => p.key)).toEqual(['flow', 'people'])
  })

  it('375: one column, attention first, the feed last', () => {
    const a = arrangeBoard(defs, boardSizeFor(375))
    expect(a.columns).toBe('one')
    expect(a.lead[0].key).toBe('attention')
    expect(a.under.map((p) => p.key)).toEqual(['feed'])
  })
})

describe('TV mode region cycle (CC-23)', () => {
  it('goes everywhere → each region → everywhere', () => {
    expect(nextRegion(['a', 'b'], null)).toBe('a')
    expect(nextRegion(['a', 'b'], 'a')).toBe('b')
    expect(nextRegion(['a', 'b'], 'b')).toBeNull()
    expect(nextRegion(['a', 'b'], 'unknown')).toBeNull()
  })
})

describe('theme (CC-22)', () => {
  it('TV, wallboards and "Always dark" are dark; otherwise the app decides', () => {
    expect(boardMode({ appDark: false, theme: 'app', tv: false, kiosk: false })).toBe('light')
    expect(boardMode({ appDark: true, theme: 'app', tv: false, kiosk: false })).toBe('dark')
    expect(boardMode({ appDark: false, theme: 'dark', tv: false, kiosk: false })).toBe('dark')
    expect(boardMode({ appDark: false, theme: 'app', tv: true, kiosk: false })).toBe('dark')
    expect(boardMode({ appDark: false, theme: null, tv: false, kiosk: true })).toBe('dark')
  })

  // WCAG relative-luminance contrast; chips are drawn over a panel.
  const rgb = (v: string): [number, number, number] => {
    const m = v.match(/rgba?\(([^)]+)\)/)
    if (m) {
      const [r, g, b] = m[1].split(',').map((x) => Number(x.trim()))
      return [r, g, b]
    }
    const h = v.replace('#', '')
    return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
  }
  const alpha = (v: string) => {
    const m = v.match(/rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/)
    return m ? Number(m[1]) : 1
  }
  const over = (fg: string, bg: string): [number, number, number] => {
    const a = alpha(fg)
    const f = rgb(fg)
    const b = rgb(bg)
    return [0, 1, 2].map((i) => f[i] * a + b[i] * (1 - a)) as [number, number, number]
  }
  const lum = (c: [number, number, number]) => {
    const [r, g, b] = c.map((x) => {
      const s = x / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (a: [number, number, number], b: [number, number, number]) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
    return (x + 0.05) / (y + 0.05)
  }

  it('every body-text token is ≥ 4.5:1 on every surface, in both modes', () => {
    for (const mode of ['light', 'dark'] as const) {
      const t = (n: string) => ccToken(mode, n) as string
      const panel = t('--cc-panel')
      const surfaces = {
        bg: rgb(t('--cc-bg')),
        panel: rgb(panel),
        raised: rgb(t('--cc-raised')),
        chip: over(t('--cc-chip'), panel),
        chipHover: over(t('--cc-chip-hover'), panel)
      }
      for (const name of [
        '--cc-text',
        '--cc-strong',
        '--cc-muted',
        '--cc-faint',
        '--cc-people-text',
        '--cc-warn-text',
        '--cc-bad-text',
        '--cc-good-text',
        '--cc-accent-text'
      ]) {
        for (const [surface, bg] of Object.entries(surfaces)) {
          const r = ratio(rgb(t(name)), bg)
          expect(r, `${mode} ${name} on ${surface} = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(4.5)
        }
      }
      // Status chips: their text on their own tint.
      for (const [text, bgTok] of [
        ['--cc-bad-text', '--cc-bad-bg'],
        ['--cc-warn-text', '--cc-warn-bg']
      ]) {
        const r = ratio(rgb(t(text)), over(t(bgTok), panel))
        expect(r, `${mode} ${text} on ${bgTok}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  })
})

describe('live region (CC-27)', () => {
  it('reads list or {items} answers', () => {
    expect(attentionCount([1, 2])).toBe(2)
    expect(attentionCount({ items: [1] })).toBe(1)
    expect(attentionCount(undefined)).toBeNull()
  })
  it('announces changes only, never the first load', () => {
    expect(attentionAnnouncement(null, 3)).toBe('')
    expect(attentionAnnouncement(3, 3)).toBe('')
    expect(attentionAnnouncement(3, 5)).toBe('5 items need attention — 2 new.')
    expect(attentionAnnouncement(5, 1)).toBe('1 item needs attention.')
    expect(attentionAnnouncement(1, 0)).toBe('Nothing needs attention now.')
  })
})
