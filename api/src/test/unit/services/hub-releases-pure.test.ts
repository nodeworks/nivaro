import { describe, expect, it, vi } from 'vitest'

// Hub release operations: the pure parts — freeze windows (time zones, month ends), rollback
// rule judgement, release-note diffing, train / schedule input checks and figure parsing.

vi.mock('../../../db/index.js', () => ({ db: () => ({}), migrationsDir: '/nowhere' }))

const {
  activeFreezes,
  activeWindow,
  nextWindow,
  refusalFor,
  freezeRefusal,
  validateFreeze,
  rollbackExempt
} = await import('../../../services/hub/releases/freeze.js')
const { zonedMidnightUtc, isTimeZone } = await import('../../../services/hub/releases/zoned.js')
const { judgeFigures, validateRule } = await import(
  '../../../services/hub/releases/auto-rollback.js'
)
const { buildReleaseNotes, envKeysAdded, migrationsAdded, nivaroNotes } = await import(
  '../../../services/hub/releases/notes.js'
)
const { figuresFromAnswer } = await import('../../../services/hub/releases/figures.js')
const { validateTrain } = await import('../../../services/hub/releases/trains.js')
const { validateWhen } = await import('../../../services/hub/releases/schedules.js')
const { recentMinutesParam } = await import('../../../services/hub-link/release-params.js')

type Freeze = Parameters<typeof activeWindow>[0]

const once = (over: Partial<Freeze> = {}): Freeze => ({
  id: 1,
  app_id: null,
  name: 'Go-live',
  recurrence: 'none',
  starts_at: '2026-11-20T00:00:00.000Z',
  ends_at: '2026-11-22T00:00:00.000Z',
  days_before: null,
  days_after: null,
  time_zone: null,
  ...over
})
const monthEnd = (over: Partial<Freeze> = {}): Freeze => ({
  id: 2,
  app_id: 7,
  name: 'Month end',
  recurrence: 'month_end',
  starts_at: null,
  ends_at: null,
  days_before: 2,
  days_after: 3,
  time_zone: 'America/New_York',
  ...over
})
const t = (s: string) => Date.parse(s)

describe('time zones', () => {
  it('finds local midnight in UTC on both sides of a DST change', () => {
    // EDT (UTC-4) in October, EST (UTC-5) in December.
    expect(new Date(zonedMidnightUtc(2026, 10, 30, 'America/New_York')).toISOString()).toBe(
      '2026-10-30T04:00:00.000Z'
    )
    expect(new Date(zonedMidnightUtc(2026, 12, 1, 'America/New_York')).toISOString()).toBe(
      '2026-12-01T05:00:00.000Z'
    )
    // Day overflow rolls into the next month.
    expect(new Date(zonedMidnightUtc(2026, 11, 31, 'UTC')).toISOString()).toBe(
      '2026-12-01T00:00:00.000Z'
    )
  })
  it('knows a real zone from a made-up one', () => {
    expect(isTimeZone('Europe/Berlin')).toBe(true)
    expect(isTimeZone('Mars/Olympus')).toBe(false)
    expect(isTimeZone('')).toBe(false)
  })
})

describe('freeze windows', () => {
  it('a one-off window is on from its start until (not including) its end', () => {
    expect(activeWindow(once(), t('2026-11-19T23:59:59Z'))).toBeNull()
    expect(activeWindow(once(), t('2026-11-20T00:00:00Z'))).not.toBeNull()
    expect(activeWindow(once(), t('2026-11-22T00:00:00Z'))).toBeNull()
  })

  it('a month-end window runs from the last days of a month into the next, on its own calendar', () => {
    const f = monthEnd()
    // November 2026 has 30 days: window 29 Nov 00:00 New York → 4 Dec 00:00 New York.
    expect(activeWindow(f, t('2026-11-29T04:59:00Z'))).toBeNull() // 23:59 on the 28th, NY
    const w = activeWindow(f, t('2026-11-29T05:00:00Z'))
    expect(w && new Date(w.start).toISOString()).toBe('2026-11-29T05:00:00.000Z')
    expect(w && new Date(w.end).toISOString()).toBe('2026-12-04T05:00:00.000Z')
    // Early in the next month, last month's window still holds.
    expect(activeWindow(f, t('2026-12-03T12:00:00Z'))).not.toBeNull()
    expect(activeWindow(f, t('2026-12-04T05:00:00Z'))).toBeNull()
    // The year turns over.
    expect(activeWindow(f, t('2027-01-02T12:00:00Z'))).not.toBeNull()
  })

  it('names the next window', () => {
    const w = nextWindow(monthEnd(), t('2026-11-10T12:00:00Z'))
    expect(w && new Date(w.start).toISOString()).toBe('2026-11-29T05:00:00.000Z')
    expect(nextWindow(once(), t('2026-11-21T00:00:00Z'))).toBeNull()
  })

  it('an app window binds only its app; a Hub-wide one binds every app', async () => {
    const rows = [monthEnd({ app_id: 7 }), once({ id: 3, app_id: null })]
    const at = t('2026-11-30T12:00:00Z')
    expect(activeFreezes(rows, 7, at).map((a) => a.freeze.id)).toEqual([2])
    expect(activeFreezes(rows, 8, at)).toEqual([])
    const r = await freezeRefusal({
      appIds: [8],
      action: 'promote',
      now: t('2026-11-21T00:00:00Z'),
      rows
    })
    expect(r?.code).toBe('FROZEN')
    expect(r?.message).toMatch(/Promotions are frozen Hub-wide/)
    expect(r?.message).toMatch(/A rollback to an older version is still allowed/)
    expect(await freezeRefusal({ appIds: [8], action: 'move', now: at, rows })).toBeNull()
  })

  it('exempts only a rollback to an OLDER version than the one running', () => {
    expect(rollbackExempt('0.3.214', '0.3.215')).toBe(true)
    expect(rollbackExempt('0.3.215', '0.3.215')).toBe(false)
    expect(rollbackExempt('0.3.216', '0.3.215')).toBe(false)
    expect(rollbackExempt('0.2.999', '0.10.0')).toBe(true)
    expect(rollbackExempt('0.3.214', null)).toBe(false)
  })

  it('fails closed when the windows cannot be read', async () => {
    const r = await freezeRefusal({ appIds: [1], action: 'promote' })
    expect(r?.code).toBe('FREEZE_UNKNOWN')
    expect(r?.status).toBe(503)
  })

  it('words the refusal per action', () => {
    const active = { freeze: once(), window: { start: 0, end: t('2026-11-22T00:00:00Z') } }
    expect(refusalFor('upgrade', active)?.message).toMatch(/^Shared deployment upgrades are frozen/)
    expect(refusalFor('move', undefined)).toBeNull()
  })

  it('checks a freeze body', () => {
    expect(validateFreeze({ name: '' })).toHaveProperty('error')
    expect(
      validateFreeze({
        name: 'x',
        starts_at: '2026-11-22T00:00:00Z',
        ends_at: '2026-11-20T00:00:00Z'
      })
    ).toEqual({ error: 'ends_at must be after starts_at' })
    expect(
      validateFreeze({ name: 'x', recurrence: 'month_end', days_before: 0, days_after: 0 })
    ).toEqual({
      error: 'a month-end freeze covers at least one day'
    })
    expect(
      validateFreeze({ name: 'x', recurrence: 'month_end', days_before: 2, time_zone: 'Nope/Zone' })
    ).toHaveProperty('error')
    const ok = validateFreeze({
      name: ' Month end ',
      recurrence: 'month_end',
      days_before: 2,
      app_id: 4
    })
    expect(ok).toMatchObject({ name: 'Month end', app_id: 4, time_zone: 'UTC', days_after: 0 })
  })
})

describe('automatic rollback judgement', () => {
  const rule = {
    environment_id: 1,
    enabled: true,
    window_minutes: 30,
    max_error_pct: 5,
    min_requests: 100,
    max_crashes: 3,
    min_readiness: 70
  }
  const figures = (over: Record<string, unknown> = {}) => ({
    linked: true,
    version: '0.3.215',
    readiness_score: 90,
    recent: { minutes: 10, requests: 1000, errors_5xx: 10, crashes: 0 },
    release_facts: null,
    read_at: 'now',
    ...over
  })

  it('passes healthy figures', () => {
    expect(judgeFigures(rule, figures()).breach).toBe(false)
  })
  it('breaches on the 5xx rate only with enough requests', () => {
    const hot = judgeFigures(
      rule,
      figures({ recent: { minutes: 10, requests: 1000, errors_5xx: 60, crashes: 0 } })
    )
    expect(hot.breach).toBe(true)
    expect(hot.reason).toMatch(/5xx rate 6\.0%/)
    const few = judgeFigures(
      rule,
      figures({ recent: { minutes: 10, requests: 20, errors_5xx: 20, crashes: 0 } })
    )
    expect(few.breach).toBe(false)
  })
  it('breaches on crashes and on a low readiness, never on a missing score', () => {
    expect(
      judgeFigures(
        rule,
        figures({ recent: { minutes: 5, requests: 0, errors_5xx: 0, crashes: 3 } })
      ).breach
    ).toBe(true)
    expect(judgeFigures(rule, figures({ readiness_score: 60 })).reason).toMatch(
      /readiness score 60/
    )
    expect(judgeFigures(rule, figures({ readiness_score: null })).breach).toBe(false)
  })
  it('checks a rule body', () => {
    expect(validateRule({})).toEqual({
      error: 'set at least one threshold (5xx rate, crashes or readiness)'
    })
    expect(validateRule({ window_minutes: 2, max_crashes: 1 })).toHaveProperty('error')
    expect(validateRule({ max_error_pct: 150 })).toHaveProperty('error')
    expect(validateRule({ max_crashes: 51 })).toEqual({ error: 'max_crashes is 1 to 50' })
    expect(validateRule({ max_error_pct: '2.5', window_minutes: 15 })).toMatchObject({
      enabled: true,
      max_error_pct: 2.5,
      window_minutes: 15,
      min_requests: 50
    })
  })
})

describe('release notes', () => {
  const diffs = [
    { path: 'api/extensions/x/migrations/012_add.ts', newFile: true, deletedFile: false, diff: '' },
    {
      path: 'api/extensions/x/migrations/011_old.ts',
      newFile: false,
      deletedFile: false,
      diff: ''
    },
    { path: 'src/feature.ts', newFile: true, deletedFile: false, diff: '' },
    {
      path: 'deploy/app.env',
      newFile: false,
      deletedFile: false,
      diff: '--- a/deploy/app.env\n+++ b/deploy/app.env\n+NEW_KEY=1\n-OLD=1\n+OLD=2\n+export OTHER_KEY="x"\n # comment'
    },
    { path: 'README.md', newFile: false, deletedFile: false, diff: '+NOT_ENV=1' }
  ]
  it('names added migrations and new setting names, nothing else', () => {
    expect(migrationsAdded(diffs)).toEqual(['012_add.ts'])
    expect(envKeysAdded(diffs)).toEqual(['NEW_KEY', 'OTHER_KEY'])
  })

  it('diffs the Nivaro build facts both ways', () => {
    const a = { version: '0.3.214', migrations: ['553_a', '554_b'], env_keys: ['A'] }
    const b = { version: '0.3.215', migrations: ['553_a', '554_b', '565_c'], env_keys: ['A', 'B'] }
    expect(nivaroNotes('promote', a, b, '0.3.214', '0.3.215')).toEqual({
      migrations: ['565_c'],
      env_keys: ['B'],
      note: null
    })
    const back = nivaroNotes('rollback', b, a, '0.3.215', '0.3.214')
    expect(back.migrations).toEqual(['565_c'])
    expect(back.note).toMatch(/does not undo migrations/)
    const unknown = nivaroNotes('promote', a, null, '0.3.214', '0.3.215')
    expect(unknown.migrations).toBeNull()
    expect(unknown.note).toMatch(/not seen the build of 0\.3\.215/)
  })

  it('builds per-component notes, newest commit first, and keeps going past a failing part', async () => {
    const compare = vi.fn(async (_ctx: unknown, from: string, to: string) => ({
      commits: [
        { sha: `${from}-1`, title: 'first', author: 'A', at: null },
        { sha: `${to}-2`, title: 'second', author: 'B', at: null }
      ],
      diffs
    }))
    const notes = await buildReleaseNotes(
      {
        envId: 5,
        kind: 'promote',
        fromVersion: '0.3.214',
        toVersion: '0.3.215',
        plan: {
          steps: [
            { position: 1, component: 'api', kind: 'api', driverId: 1, sourceSha: 'bbbb' },
            { position: 2, component: 'web', kind: 'frontend', driverId: 2, sourceSha: 'cccc' },
            {
              position: 3,
              component: 'stack',
              kind: 'stack',
              driverId: 3,
              driver: 'docker',
              sourceSha: null
            }
          ] as never
        }
      },
      {
        gitCtx: async (id) => {
          if (id === 2) throw Object.assign(new Error('x'), { code: 'GITLAB_UNREACHABLE' })
          return { api: 'x', project: 'p', token: 't' } as never
        },
        compare,
        running: async (_env, s) => (s.position === 1 ? 'aaaa' : 'dddd'),
        facts: async () => null
      }
    )
    expect(notes.components).toHaveLength(2)
    expect(compare).toHaveBeenCalledWith(expect.anything(), 'aaaa', 'bbbb')
    expect(notes.components[0]).toMatchObject({
      direction: 'added',
      total_commits: 2,
      migrations: ['012_add.ts'],
      env_keys: ['NEW_KEY', 'OTHER_KEY']
    })
    expect(notes.components[0].commits[0].title).toBe('second')
    expect(notes.components[1].error).toBe('GitLab did not answer')
    expect(notes.nivaro.migrations).toBeNull()
  })

  it('a rollback compares the running build against the older one (what goes away)', async () => {
    const compare = vi.fn(async () => ({ commits: [], diffs: [] }))
    const notes = await buildReleaseNotes(
      {
        envId: 5,
        kind: 'rollback',
        fromVersion: '0.3.215',
        toVersion: '0.3.214',
        plan: {
          steps: [
            { position: 1, component: 'api', kind: 'api', driverId: 1, sourceSha: 'old1' }
          ] as never
        }
      },
      {
        gitCtx: async () => ({}) as never,
        compare,
        running: async () => 'new1',
        facts: async () => null
      }
    )
    expect(compare).toHaveBeenCalledWith(expect.anything(), 'old1', 'new1')
    expect(notes.components[0].direction).toBe('removed')
  })
})

describe('inputs and figures', () => {
  const envs = [
    { id: 1, key: 'development', position: 0 },
    { id: 2, key: 'staging', position: 1 },
    { id: 3, key: 'production', position: 2 },
    { id: 4, key: 'demo', position: 3, on_shared: true }
  ]
  it('a train follows the app’s environment order', () => {
    const ok = validateTrain(
      {
        version: '0.3.215',
        steps: [{ environment_id: 2, soak_minutes: 30, min_readiness: 80 }, { environment_id: 3 }]
      },
      envs
    )
    expect(ok).toMatchObject({ keys: ['staging', 'production'] })
    expect(validateTrain({ version: '0.3', steps: [] }, envs)).toHaveProperty('error')
    expect(
      validateTrain(
        { version: '0.3.215', steps: [{ environment_id: 3 }, { environment_id: 2 }] },
        envs
      )
    ).toEqual({
      error: 'steps follow the app’s environment order (earliest first)'
    })
    expect(
      validateTrain({ version: '0.3.215', steps: [{ environment_id: 4 }] }, envs)
    ).toHaveProperty('error')
    expect(
      validateTrain({ version: '0.3.215', steps: [{ environment_id: 1, min_readiness: 0 }] }, envs)
    ).toHaveProperty('error')
  })

  it('a schedule is in the future, within 90 days', () => {
    const now = t('2026-11-24T12:00:00Z')
    expect(validateWhen({ run_at: '2026-11-24T11:00:00Z' }, now)).toEqual({
      error: 'run_at is in the past'
    })
    expect(validateWhen({ run_at: '2027-06-01T00:00:00Z' }, now)).toHaveProperty('error')
    expect(validateWhen({ run_at: '2026-11-25T02:00:00Z', on_freeze: 'fail' }, now)).toMatchObject({
      on_freeze: 'fail'
    })
    expect(
      validateWhen({ run_at: '2026-11-25T02:00:00Z', on_freeze: 'maybe' }, now)
    ).toHaveProperty('error')
  })

  it('reads a status answer into figures, dropping anything odd', () => {
    const f = figuresFromAnswer(
      {
        version: '0.3.215',
        readiness_score: 88,
        recent: { minutes: 5, requests: 10, errors_5xx: -1, crashes: 0 },
        release_facts: { migrations: ['565_a', '../etc'], env_keys: ['A_B', 7] }
      },
      'now'
    )
    expect(f).toMatchObject({ linked: true, readiness_score: 88 })
    expect(f.recent).toEqual({ minutes: 5, requests: 10, errors_5xx: null, crashes: 0 })
    expect(f.release_facts).toEqual({
      version: '0.3.215',
      migrations: ['565_a'],
      env_keys: ['A_B']
    })
  })

  it('clamps ?recent_minutes', () => {
    expect(recentMinutesParam('15')).toBe(15)
    expect(recentMinutesParam('999')).toBe(60)
    expect(recentMinutesParam('0')).toBeNull()
    expect(recentMinutesParam('x')).toBeNull()
    expect(recentMinutesParam(undefined)).toBeNull()
  })
})
