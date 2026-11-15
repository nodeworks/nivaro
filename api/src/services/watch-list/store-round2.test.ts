import { describe, expect, it } from 'vitest'
import {
  addPin,
  normalizeDock,
  normalizeWatchList,
  removePin,
  serializeWatchList,
  TEAM_SEEN_MAX
} from './store.js'

const T0 = new Date('2026-11-14T10:00:00Z')
const OWNER = '6f1c2a10-0000-4000-8000-000000000001'

describe('watch list store — round 2 keys', () => {
  it('reads settings, alerts and shared lists from any stored shape', () => {
    const l = normalizeWatchList({
      pins: [{ c: 'orders', id: '5', at: '2026-11-01T00:00:00Z', auto: true }],
      settings: { desktop: true, auto_add: 'yes', digest: true },
      alerts: [
        { id: 'abcd1234', c: 'orders', rid: '5', kind: 'step', step: 'approved', repeat: true },
        { id: 'abcd1235', c: 'orders', rid: '6', kind: 'overdue' }, // not pinned → dropped
        { id: 'abcd1236', c: 'orders', rid: '5', kind: 'field' }, // no field → dropped
        { id: 'abcd1237', c: 'orders', rid: '5', kind: 'nonsense' }
      ],
      teams: [
        {
          id: `${OWNER}~abc12345`,
          name: '  Ops  ',
          owner: OWNER,
          members: [{ u: OWNER }, { u: OWNER }, { u: 'bad id' }],
          pins: [{ c: 'orders', id: '9', by: OWNER }]
        },
        { id: 'not-a-team-id', name: 'x', owner: OWNER }
      ],
      team_refs: [`${OWNER}~abc12345`, 'junk', `${OWNER}~abc12345`],
      digest_sent_on: '2026-11-13'
    })
    expect(l.pins[0].auto).toBe(true)
    expect(l.settings).toEqual({
      desktop: true,
      auto_add: false,
      auto_remove: false,
      digest: true,
      remove_completed: false
    })
    expect(l.alerts.map((a) => a.id)).toEqual(['abcd1234'])
    expect(l.alerts[0].repeat).toBe(true)
    expect(l.teams).toHaveLength(1)
    expect(l.teams[0].name).toBe('Ops')
    expect(l.teams[0].members).toHaveLength(1)
    expect(l.team_refs).toEqual([`${OWNER}~abc12345`])
    expect(l.digest_sent_on).toBe('2026-11-13')
  })

  it('accepts a shared list tab and refuses a made-up one', () => {
    expect(normalizeDock({ tab: `team:${OWNER}~abc12345` }).tab).toBe(`team:${OWNER}~abc12345`)
    expect(normalizeDock({ tab: 'team:../../x' }).tab).toBe('watching')
  })

  it('unpinning a record takes its alert rules with it', () => {
    const base = normalizeWatchList({
      pins: [{ c: 'orders', id: '5', at: '2026-11-01T00:00:00Z' }],
      alerts: [{ id: 'abcd1234', c: 'orders', rid: '5', kind: 'overdue' }]
    })
    expect(base.alerts).toHaveLength(1)
    expect(removePin(base, 'orders', '5').list.alerts).toEqual([])
  })

  it('marks an automatic pin as such', () => {
    const r = addPin(normalizeWatchList(undefined), 'orders', '5', T0, { auto: true })
    expect(r.ok && r.list.pins[0].auto).toBe(true)
  })

  it('writes the flags the background passes look for', () => {
    const l = normalizeWatchList({
      pins: [{ c: 'orders', id: '5' }],
      settings: { digest: true, auto_add: true },
      alerts: [{ id: 'abcd1234', c: 'orders', rid: '5', kind: 'overdue' }]
    })
    const out = serializeWatchList(l)
    expect(out).toMatchObject({ wl_alerts: true, wl_auto: true, wl_digest: true })
    const quiet = serializeWatchList(normalizeWatchList(undefined))
    expect(quiet.wl_alerts).toBeUndefined()
    expect(quiet.wl_digest).toBeUndefined()
  })

  it('keeps only the newest shared-list seen marks', () => {
    const raw: Record<string, string> = {}
    for (let i = 0; i < TEAM_SEEN_MAX + 20; i++)
      raw[`${OWNER}~abc12345|orders:${i}`] = new Date(T0.getTime() + i * 1000).toISOString()
    raw['bogus|orders:1'] = T0.toISOString()
    const l = normalizeWatchList({ team_seen: raw })
    expect(Object.keys(l.team_seen)).toHaveLength(TEAM_SEEN_MAX)
    expect(l.team_seen[`${OWNER}~abc12345|orders:0`]).toBeUndefined()
    expect(l.team_seen['bogus|orders:1']).toBeUndefined()
  })
})
