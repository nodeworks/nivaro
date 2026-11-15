// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  countNewSince,
  newCountLabel,
  readSeen,
  type SeenEntry,
  seenKey,
  useNewSince,
  writeSeen
} from './seen-since'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// rt4-notify item 5: "2 new" on a folded Comments / Tasks panel, counted since you last had it open.

const ME = 'me-1'
const t = (iso: string) => new Date(iso).getTime()

describe('countNewSince', () => {
  const entries: SeenEntry[] = [
    { at: '2026-11-14T10:00:00Z', by: 'al' },
    { at: '2026-11-14T11:00:00Z', by: 'ME-1' },
    { at: '2026-11-14T12:00:00Z', by: 'beth' },
    { at: null, by: 'cy' }
  ]
  it('counts what other people added after the mark', () => {
    expect(countNewSince(entries, t('2026-11-14T09:00:00Z'), ME)).toBe(2)
    expect(countNewSince(entries, t('2026-11-14T10:30:00Z'), ME)).toBe(1)
    expect(countNewSince(entries, t('2026-11-14T13:00:00Z'), ME)).toBe(0)
  })
  it('no mark yet counts nothing', () => {
    expect(countNewSince(entries, null, ME)).toBe(0)
  })
  it('labels', () => {
    expect(newCountLabel(0)).toBeNull()
    expect(newCountLabel(2)).toBe('2 new')
    expect(newCountLabel(150)).toBe('99+ new')
  })
})

describe('useNewSince', () => {
  let root: ReturnType<typeof createRoot> | null = null
  let host: HTMLDivElement | null = null
  afterEach(() => {
    act(() => root?.unmount())
    host?.remove()
    root = null
    host = null
    window.localStorage.clear()
  })

  function render(props: { open: boolean; entries: SeenEntry[] }) {
    let count = -1
    function Probe() {
      count = useNewSince({
        userId: ME,
        collection: 'workflows',
        item: '42',
        tab: 'comments',
        ready: true,
        ...props
      })
      return null
    }
    if (!host) {
      host = document.createElement('div')
      document.body.appendChild(host)
      root = createRoot(host)
    }
    act(() => root!.render(<Probe />))
    return count
  }

  it('the first visit sets the mark to now — an old record never opens on "12 new"', () => {
    const old: SeenEntry[] = [{ at: '2020-01-01T00:00:00Z', by: 'al' }]
    expect(render({ open: false, entries: old })).toBe(0)
    expect(readSeen(seenKey(ME, 'workflows', '42', 'comments'))).not.toBeNull()
  })

  it("counts others' new entries while folded, clears when opened", () => {
    const key = seenKey(ME, 'workflows', '42', 'comments')
    writeSeen(key, t('2026-11-14T10:00:00Z'))
    const entries: SeenEntry[] = [
      { at: '2026-11-14T09:00:00Z', by: 'al' },
      { at: '2026-11-14T11:00:00Z', by: 'al' },
      { at: '2026-11-14T11:30:00Z', by: 'beth' },
      { at: '2026-11-14T11:45:00Z', by: ME }
    ]
    expect(render({ open: false, entries })).toBe(2)
    // A live arrival: the list grows, the count follows.
    const more = [...entries, { at: '2026-11-14T12:00:00Z', by: 'cy' }]
    expect(render({ open: false, entries: more })).toBe(3)
    // Opened: cleared, and the mark moves to now.
    expect(render({ open: true, entries: more })).toBe(0)
    expect(readSeen(key)).toBeGreaterThan(t('2026-11-14T12:00:00Z'))
    // Closed again: only what comes after counts.
    expect(render({ open: false, entries: more })).toBe(0)
  })
})
