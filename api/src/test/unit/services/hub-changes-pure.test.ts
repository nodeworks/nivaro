import { describe, expect, it, vi } from 'vitest'
import {
  type ChecklistItem,
  entriesFor,
  mayTick,
  missingRequired,
  validateItem
} from '../../../services/hub/changes/checklist.js'
import { foldLine, icsText, icsTime, renderIcs } from '../../../services/hub/changes/ics.js'
import { freezeRefusal, type HubFreeze } from '../../../services/hub/releases/freeze.js'
import {
  rangeWords,
  validateRanges,
  weeklyNextSpan,
  weeklySpanAt,
  weeklySpans
} from '../../../services/hub/releases/weekly.js'
import {
  type DeployWindow,
  governingWindows,
  judgeWindows,
  validateWindow,
  windowRefusalFor
} from '../../../services/hub/releases/windows.js'

vi.mock('../../../db/index.js', () => ({ db: () => ({}), migrationsDir: '/nowhere' }))

// Hub change operations, the pure parts: weekly deploy windows on a zone's calendar (DST),
// which windows govern an environment, the refusal the ONE release-time engine answers,
// pre-deploy checklist rules, and the iCalendar export.

const NY = 'America/New_York'
const WEEKDAYS_7_17 = [{ days: [1, 2, 3, 4, 5], from: '07:00', to: '17:00' }]
const at = (s: string) => Date.parse(s)

function win(over: Partial<DeployWindow> = {}): DeployWindow {
  return {
    id: 1,
    app_id: 1,
    name: 'Office hours',
    env_scope: 'production',
    recurrence: 'weekly',
    ranges: WEEKDAYS_7_17,
    starts_at: null,
    ends_at: null,
    time_zone: NY,
    enabled: true,
    ...over
  }
}

describe('weekly ranges', () => {
  it('reads wall-clock times in the zone, across a DST change', () => {
    // Wed 2026-03-04 (EST, UTC-5): 7 AM ET = 12:00 UTC.
    const s = weeklySpanAt(WEEKDAYS_7_17, NY, at('2026-03-04T15:00:00Z'))
    expect(s && new Date(s.start).toISOString()).toBe('2026-03-04T12:00:00.000Z')
    expect(s && new Date(s.end).toISOString()).toBe('2026-03-04T22:00:00.000Z')
    // Wed 2026-03-11 (EDT, UTC-4): 7 AM ET = 11:00 UTC — still 7 AM on the wall.
    const t = weeklySpanAt(WEEKDAYS_7_17, NY, at('2026-03-11T15:00:00Z'))
    expect(t && new Date(t.start).toISOString()).toBe('2026-03-11T11:00:00.000Z')
    // 6:30 AM ET is outside.
    expect(weeklySpanAt(WEEKDAYS_7_17, NY, at('2026-03-11T10:30:00Z'))).toBeNull()
  })

  it('a weekend is closed and the next opening is Monday 7 AM', () => {
    const sat = at('2026-11-28T15:00:00Z')
    expect(weeklySpanAt(WEEKDAYS_7_17, NY, sat)).toBeNull()
    const next = weeklyNextSpan(WEEKDAYS_7_17, NY, sat)
    expect(next && new Date(next.start).toISOString()).toBe('2026-11-30T12:00:00.000Z')
  })

  it('a range past midnight joins the next day and adjacent ranges merge', () => {
    const ranges = [
      { days: [5], from: '22:00', to: '02:00' },
      { days: [6], from: '02:00', to: '04:00' }
    ]
    const spans = weeklySpans(ranges, 'UTC', at('2026-11-27T00:00:00Z'), at('2026-11-29T00:00:00Z'))
    expect(spans).toEqual([{ start: at('2026-11-27T22:00:00Z'), end: at('2026-11-28T04:00:00Z') }])
  })

  it('validates and words ranges', () => {
    expect(validateRanges([])).toEqual({ error: 'ranges needs at least one range' })
    expect(validateRanges([{ days: [8], from: '07:00', to: '08:00' }])).toHaveProperty('error')
    expect(validateRanges([{ days: [1], from: '7:00', to: '08:00' }])).toHaveProperty('error')
    expect(validateRanges([{ days: [1], from: '08:00', to: '08:00' }])).toHaveProperty('error')
    expect(validateRanges([{ days: [3, 1, 1], from: '00:00', to: '24:00' }])).toEqual([
      { days: [1, 3], from: '00:00', to: '24:00' }
    ])
    expect(rangeWords(WEEKDAYS_7_17[0])).toBe('Weekdays 7 AM–5 PM')
    expect(rangeWords({ days: [1, 2, 3, 4], from: '09:30', to: '24:00' })).toBe(
      'Mon–Thu 9:30 AM–midnight'
    )
  })
})

describe('which deploy windows govern', () => {
  const now = at('2026-11-28T15:00:00Z') // a Saturday
  it('the app’s own windows replace the Hub-wide ones; none at all = any time', () => {
    const hubWide = win({ id: 2, app_id: null, env_scope: 'all', name: 'Hub hours' })
    expect(governingWindows([hubWide], 1, true, now).map((w) => w.id)).toEqual([2])
    expect(governingWindows([hubWide, win()], 1, true, now).map((w) => w.id)).toEqual([1])
    expect(judgeWindows([], 1, true, now)).toMatchObject({ governed: false, open: true })
  })

  it('production windows govern production only; unknown production skips them', () => {
    expect(judgeWindows([win()], 1, false, now).governed).toBe(false)
    expect(judgeWindows([win()], 1, null, now).governed).toBe(false)
    expect(judgeWindows([win()], 1, true, now)).toMatchObject({ governed: true, open: false })
  })

  it('an ended one-off window governs nothing; a running one opens the app', () => {
    const ended = win({
      recurrence: 'none',
      starts_at: '2026-11-01T00:00:00.000Z',
      ends_at: '2026-11-02T00:00:00.000Z'
    })
    expect(judgeWindows([ended], 1, true, now).governed).toBe(false)
    const extra = win({
      id: 3,
      recurrence: 'none',
      starts_at: '2026-11-28T14:00:00.000Z',
      ends_at: '2026-11-28T16:00:00.000Z'
    })
    const j = judgeWindows([win(), extra], 1, true, now)
    expect(j.open).toBe(true)
    expect(j.current?.window.id).toBe(3)
  })

  it('the refusal carries the next opening; a disabled window is ignored', () => {
    const j = judgeWindows([win()], 1, true, now)
    const r = windowRefusalFor('promote', j)
    expect(r?.code).toBe('OUTSIDE_WINDOW')
    expect(r?.status).toBe(409)
    expect(r?.freeze.ends_at).toBe('2026-11-30T12:00:00.000Z')
    expect(r?.message).toContain('Weekdays 7 AM–5 PM (America/New_York)')
    expect(windowRefusalFor('move', j)).toBeNull()
    expect(judgeWindows([win({ enabled: false })], 1, true, now).governed).toBe(false)
  })

  it('validates a window body', () => {
    expect(validateWindow({ name: '' })).toHaveProperty('error')
    expect(validateWindow({ name: 'x', time_zone: 'Mars/Base' })).toHaveProperty('error')
    const ok = validateWindow({ name: 'Office', ranges: WEEKDAYS_7_17, time_zone: NY })
    expect(ok).toMatchObject({ env_scope: 'production', recurrence: 'weekly', time_zone: NY })
    expect(
      validateWindow({
        name: 'Long',
        recurrence: 'none',
        starts_at: '2026-01-01T00:00:00Z',
        ends_at: '2026-03-01T00:00:00Z'
      })
    ).toHaveProperty('error')
  })
})

describe('one release-time engine', () => {
  const freeze: HubFreeze = {
    id: 9,
    app_id: null,
    name: 'Year end',
    recurrence: 'none',
    starts_at: '2026-11-28T00:00:00.000Z',
    ends_at: '2026-11-29T00:00:00.000Z',
    days_before: null,
    days_after: null,
    time_zone: null
  }
  const now = at('2026-11-28T15:00:00Z')

  it('a freeze wins over a window; a window alone refuses promote and apply only', async () => {
    expect(
      (await freezeRefusal({ appIds: [1], action: 'promote', now, rows: [freeze], windows: [] }))
        ?.code
    ).toBe('FROZEN')
    const windows = [win({ env_scope: 'all' })]
    expect(
      (await freezeRefusal({ appIds: [1], action: 'promote', now, rows: [], windows }))?.code
    ).toBe('OUTSIDE_WINDOW')
    expect(
      (await freezeRefusal({ appIds: [1], action: 'apply', now, rows: [], windows }))?.code
    ).toBe('OUTSIDE_WINDOW')
    expect(await freezeRefusal({ appIds: [1], action: 'move', now, rows: [], windows })).toBeNull()
    // Rows handed in without windows = the caller judges freezes only (older callers, tests).
    expect(await freezeRefusal({ appIds: [1], action: 'promote', now, rows: [] })).toBeNull()
  })
})

describe('pre-deploy checklist rules', () => {
  const item = (over: Partial<ChecklistItem> = {}): ChecklistItem => ({
    id: 1,
    app_id: 1,
    environment_id: null,
    text: 'Support told',
    help: null,
    required: true,
    tick_by: 'owner',
    tick_people: [],
    actions: ['promote', 'move', 'upgrade'],
    position: 0,
    archived: false,
    ...over
  })
  const prod = { env_id: 20, env_key: 'prod', app_id: 1, app_key: 'acme' }

  it('entries apply per production environment, action and environment', () => {
    const list = entriesFor(
      [
        item(),
        item({ id: 2, environment_id: 21 }),
        item({ id: 3, actions: ['move'] }),
        item({ id: 4, archived: true }),
        item({ id: 5, app_id: 2 })
      ],
      [prod],
      'promote'
    )
    expect(list.map((e) => e.key)).toEqual(['1@20'])
  })

  it('who may tick', () => {
    const owner = { id: 'u1', isAdmin: false, owns: new Set([1]) }
    const admin = { id: 'a1', isAdmin: true, owns: new Set<number>() }
    const named = { id: 'BB-1', isAdmin: false, owns: new Set<number>() }
    const e = entriesFor([item()], [prod], 'promote')[0]
    expect(mayTick(e, owner)).toBe(true)
    expect(mayTick({ ...e, tick_by: 'admin' }, owner)).toBe(false)
    expect(mayTick({ ...e, tick_by: 'admin' }, admin)).toBe(true)
    // Named people only — an admin who is not named may not tick it.
    const people = { ...e, tick_by: 'people' as const, tick_people: ['bb-1'] }
    expect(mayTick(people, named)).toBe(true)
    expect(mayTick(people, admin)).toBe(false)
  })

  it('missing = required and not ticked', () => {
    const list = entriesFor([item(), item({ id: 2, required: false })], [prod], 'promote')
    expect(missingRequired(list, {}).map((e) => e.key)).toEqual(['1@20'])
    expect(
      missingRequired(list, { '1@20': { by: 'u', by_name: null, at: 'x', note: null } })
    ).toEqual([])
  })

  it('validates an item', () => {
    expect(validateItem({ app_id: 1, text: '' })).toHaveProperty('error')
    expect(validateItem({ app_id: 1, text: 'x', tick_by: 'people' })).toHaveProperty('error')
    expect(validateItem({ app_id: 1, text: 'x', actions: ['deploy'] })).toHaveProperty('error')
    expect(validateItem({ app_id: 1, text: ' Backups checked ' })).toMatchObject({
      text: 'Backups checked',
      required: true,
      tick_by: 'owner',
      actions: 'promote,move,upgrade'
    })
  })
})

describe('iCalendar export', () => {
  it('escapes, folds and writes UTC times; windows are left out', () => {
    expect(icsTime(at('2026-11-30T12:05:09Z'))).toBe('20261130T120509Z')
    expect(icsText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne')
    const long = `SUMMARY:${'x'.repeat(200)}`
    expect(
      foldLine(long)
        .split('\r\n')
        .every((l) => Buffer.byteLength(l) <= 75)
    ).toBe(true)
    const ics = renderIcs(
      [
        {
          id: 'deploy:1',
          kind: 'promote',
          title: 'Promote acme · prod to 0.3.215',
          app_id: 1,
          app_key: 'acme',
          environment_id: 20,
          env_key: 'prod',
          start: '2026-11-30T12:00:00.000Z',
          end: null,
          status: 'planned',
          detail: null
        },
        {
          id: 'window:1:1',
          kind: 'window',
          title: 'Deploy window',
          app_id: 1,
          app_key: 'acme',
          environment_id: null,
          env_key: null,
          start: '2026-11-30T12:00:00.000Z',
          end: '2026-11-30T22:00:00.000Z',
          status: 'planned',
          detail: null
        }
      ],
      { name: 'Acme changes', host: 'hub.example.com', now: at('2026-11-25T00:00:00Z') }
    )
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true)
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(1)
    expect(ics).toContain('UID:deploy:1@hub.example.com')
    expect(ics).toContain('DTSTART:20261130T120000Z')
    expect(ics).toContain('DTEND:20261130T121500Z')
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
  })
})
