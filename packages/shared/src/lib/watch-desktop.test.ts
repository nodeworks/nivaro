// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { claimBurst, DESKTOP_FRESH_MS, desktopText, keysToNotify } from './watch-desktop'
import { withPrefDefaults } from './watch-list'

const NOW = new Date('2026-11-14T12:00:00Z').getTime()
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('desktop alerts for watched records', () => {
  it('tells only about fresh changes someone else made, once each', () => {
    const others = { 'po:1': ago(5_000), 'po:2': ago(DESKTOP_FRESH_MS + 1000), 'po:4': ago(1000) }
    const told = new Map([['po:4', ago(1000)]])
    // po:3 changed in the burst but the server knows no one else's change: it was the person's own.
    expect(keysToNotify(['po:1', 'po:2', 'po:3', 'po:4', 'po:1'], others, told, NOW)).toEqual([
      'po:1'
    ])
  })

  it('words one or many changes without values', () => {
    expect(desktopText(['po:1'], { 'po:1': 'PO 1001' })).toEqual({
      title: 'Watch list',
      body: 'PO 1001 changed'
    })
    expect(desktopText(['po:1'], {}).body).toBe('A record you watch changed')
    expect(desktopText(['po:1', 'po:2', 'po:3'], { 'po:1': 'A', 'po:2': 'B' }).body).toBe(
      '3 records you watch changed: A, B…'
    )
  })

  it('lets one tab claim a burst', () => {
    window.localStorage.clear()
    expect(claimBurst(['po:2', 'po:1'], NOW)).toBe(true)
    expect(claimBurst(['po:1', 'po:2'], NOW + 1000)).toBe(false)
    expect(claimBurst(['po:1', 'po:2'], NOW + 60_000)).toBe(true)
  })

  it('fills settings, alerts and shared lists an older answer left out', () => {
    const p = withPrefDefaults({ pins: [], max: 50 } as never)
    expect(p.settings).toEqual({
      desktop: false,
      auto_add: false,
      auto_remove: false,
      digest: false,
      remove_completed: false
    })
    expect(p.alerts).toEqual([])
    expect(p.teams).toEqual([])
  })
})
