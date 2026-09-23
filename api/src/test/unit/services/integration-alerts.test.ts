import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/pipeline-engine.js', () => ({
  resolveStateOwnersBatch: vi.fn()
}))
vi.mock('../../../services/workflow-transitions.js', () => ({
  resolveFriendlyId: vi.fn().mockResolvedValue('CM26-00001')
}))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn().mockResolvedValue({ id: 1, decision: null, lane: 'needs_you' })
}))
// Capturing the digest provider is the only way to reach
// buildIntegrationDigestSection, which is deliberately not exported.
vi.mock('../../../services/daily-digest.js', () => ({ registerDigestSection: vi.fn() }))

import { db } from '../../../db/index.js'
import { registerDigestSection } from '../../../services/daily-digest.js'
import {
  alertUnmetObligations,
  dedupeCutoff,
  registerIntegrationDigest,
  setApp,
  shouldNotify
} from '../../../services/integration-alerts.js'
import { notifyUser } from '../../../services/notification-channels.js'
import { resolveStateOwnersBatch } from '../../../services/pipeline-engine.js'

const now = new Date('2026-09-22T12:00:00Z')
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000)

describe('shouldNotify', () => {
  it('alerts on an unmet outcome nobody has been told about', () => {
    expect(shouldNotify({ outcome: 'missing', notified_at: null }, now, 12)).toBe(true)
    expect(shouldNotify({ outcome: 'failed', notified_at: null }, now, 12)).toBe(true)
    expect(shouldNotify({ outcome: 'overdue', notified_at: null }, now, 12)).toBe(true)
  })

  it('never alerts on a met outcome', () => {
    expect(shouldNotify({ outcome: 'sent', notified_at: null }, now, 12)).toBe(false)
    expect(shouldNotify({ outcome: 'pending', notified_at: null }, now, 12)).toBe(false)
    expect(shouldNotify({ outcome: 'skipped', notified_at: null }, now, 12)).toBe(false)
    expect(shouldNotify({ outcome: 'superseded', notified_at: null }, now, 12)).toBe(false)
  })

  it('stays quiet inside the dedupe window — a sweep every 15 minutes must not alert every 15 minutes', () => {
    expect(shouldNotify({ outcome: 'missing', notified_at: hoursAgo(1) }, now, 12)).toBe(false)
  })

  it('speaks again once the window has passed', () => {
    expect(shouldNotify({ outcome: 'missing', notified_at: hoursAgo(13) }, now, 12)).toBe(true)
  })

  it('treats the boundary as passed rather than holding a row silent forever', () => {
    expect(shouldNotify({ outcome: 'missing', notified_at: hoursAgo(12) }, now, 12)).toBe(true)
  })
})

describe('dedupeCutoff', () => {
  // The atomic claim in alertUnmetObligations() computes its SQL WHERE
  // boundary from this exact function — a row `notified_at` at the cutoff
  // must read as "past the window" in BOTH places, or a row shouldNotify
  // lets through can lose its own claim to a `<` that excludes the boundary
  // it just qualified on.
  it('is exactly the instant shouldNotify treats as "the window has passed"', () => {
    const cutoff = dedupeCutoff(now, 12)
    expect(cutoff.getTime()).toBe(hoursAgo(12).getTime())
    expect(shouldNotify({ outcome: 'missing', notified_at: cutoff }, now, 12)).toBe(true)
  })

  it('one millisecond newer than the cutoff is still inside the window', () => {
    const justInsideWindow = new Date(dedupeCutoff(now, 12).getTime() + 1)
    expect(shouldNotify({ outcome: 'missing', notified_at: justInsideWindow }, now, 12)).toBe(false)
  })
})

// ─── alertUnmetObligations — recipients, casing, claim ordering ────────────
// db is mocked globally in src/test/setup.ts (db(table) is a vi.fn() whose
// return value each test overrides with its own fake query chain), same
// pattern as src/test/unit/services/integration-reconcile.test.ts.

const mockedDb = () => vi.mocked(db as unknown as (table: string) => unknown)

/** A chainable fake query builder: every knex method used by
 *  integration-alerts.ts returns the SAME object (so `db(table).where(...)
 *  .where(...).update(...)` all resolve against one configured chain),
 *  terminal methods resolve whatever the caller passes in. `.where`'s
 *  second call in the real code passes a CALLBACK (the nested notified_at
 *  OR clause) — the mock never invokes it, so it needs no real qb behind
 *  it, only to keep returning the chain. */
function makeChain(overrides: { select?: unknown[]; first?: unknown; update?: number } = {}) {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockResolvedValue(overrides.select ?? []),
    first: vi.fn().mockResolvedValue(overrides.first),
    update: vi.fn().mockResolvedValue(overrides.update ?? 1)
  }
  for (const m of ['where', 'whereIn', 'whereNull', 'orWhere', 'orderBy', 'limit']) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  return chain
}

const fakeApp = {} as Parameters<typeof setApp>[0]

const row = {
  id: 1,
  api: 'Partner',
  kind: 'push',
  collection: 'workflows',
  item: '10',
  outcome: 'missing',
  reason: 'no send was ever attempted',
  notified_at: null
}

describe('alertUnmetObligations', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('dedupes an API owner and a resolved record owner that are the SAME person under different id casing — notifies once, not twice', async () => {
    setApp(fakeApp)
    const settingsChain = makeChain({ first: { integration_notifications_enabled: true } })
    const obligationsChain = makeChain({ select: [row], update: 1 })
    const apisChain = makeChain({
      select: [{ name: 'Partner', owner_user: 'aaaaaaaa-0000-0000-0000-000000000001' }]
    })
    const instancesChain = makeChain({
      select: [{ collection: 'workflows', item: '10', id: 'inst-1', current_state: 'st-1' }]
    })
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settingsChain
      if (table === 'nivaro_integration_obligations') return obligationsChain
      if (table === 'nivaro_external_apis') return apisChain
      if (table === 'nivaro_workflow_instances') return instancesChain
      throw new Error(`unexpected table: ${table}`)
    }) as never)
    // Same person as the API owner above, spelled in the OPPOSITE case —
    // exactly the shape a real uniqueidentifier round-trip can produce.
    vi.mocked(resolveStateOwnersBatch).mockResolvedValue(
      new Map([['workflows::10', [{ id: 'AAAAAAAA-0000-0000-0000-000000000001' }]]]) as never
    )

    const r = await alertUnmetObligations()

    expect(r).toEqual({ notified: 1 })
    expect(notifyUser).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyUser).mock.calls[0][1]).toBe('AAAAAAAA-0000-0000-0000-000000000001')
    expect(obligationsChain.update).toHaveBeenCalledWith({ notified_at: expect.any(Date) })
  })

  it('claims a row with no resolvable recipient so it never occupies every future sweep — and warns once, without notifying anyone', async () => {
    setApp(fakeApp)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const settingsChain = makeChain({ first: { integration_notifications_enabled: true } })
    const obligationsChain = makeChain({ select: [row], update: 1 })
    // No API owner, and no open workflow instance to resolve owners from.
    const apisChain = makeChain({ select: [{ name: 'Partner', owner_user: null }] })
    const instancesChain = makeChain({ select: [] })
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settingsChain
      if (table === 'nivaro_integration_obligations') return obligationsChain
      if (table === 'nivaro_external_apis') return apisChain
      if (table === 'nivaro_workflow_instances') return instancesChain
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    const r = await alertUnmetObligations()

    expect(r).toEqual({ notified: 0 })
    expect(notifyUser).not.toHaveBeenCalled()
    // Claimed anyway — the row is stamped notified_at even though nobody
    // was told, so it drops out of the next 200-row batch for this window
    // instead of sitting there forever.
    expect(obligationsChain.update).toHaveBeenCalledWith({ notified_at: expect.any(Date) })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/1 unmet obligation.*no resolvable recipient/)
    warn.mockRestore()
  })
})

// The "no app set → never touches the database" guard these two tests both
// depend on (setApp(fakeApp) is what lets them reach db() at all) is
// exercised for real, not just documented, by
// integration-reconcile.test.ts's "runIntegrationReconcile writes nothing …
// db not called" assertions — that suite never calls setApp(), so
// alertUnmetObligations() returns before its first db() call there.

// ─── I3: the digest obeys the SAME switch the immediate alert does ─────────

describe('the daily digest section', () => {
  afterEach(() => vi.clearAllMocks())

  /** The provider daily-digest.ts would call once per user. */
  function digestProvider(): (userId: string) => Promise<unknown> {
    registerIntegrationDigest()
    const fn = vi.mocked(registerDigestSection).mock.calls.at(-1)?.[0]
    if (!fn) throw new Error('no digest section was registered')
    return fn as (userId: string) => Promise<unknown>
  }

  it('returns nothing — and reads no obligations at all — while notifications are off', async () => {
    const settingsChain = makeChain({ first: { integration_notifications_enabled: false } })
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settingsChain
      // Any other table here means the gate did not come first.
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    await expect(digestProvider()('AAAAAAAA-0000-0000-0000-000000000001')).resolves.toBeNull()
  })
})

// ─── I5: a row whose "record" is not one links to the board, not a 404 ─────

describe('the notification target', () => {
  afterEach(() => vi.clearAllMocks())

  it('carries no record id when the collection has no record route — the board is the destination', async () => {
    setApp(fakeApp)
    const inboundRow = {
      ...row,
      kind: 'inbound',
      collection: 'nivaro_api_logs',
      // A bucket key, not a record id — `/collections/nivaro_api_logs/…`
      // cannot resolve, so a record target would land on an error page.
      item: '/graphql@2026-09-23T14'
    }
    const settingsChain = makeChain({ first: { integration_notifications_enabled: true } })
    const obligationsChain = makeChain({ select: [inboundRow], update: 1 })
    const apisChain = makeChain({
      select: [{ name: 'Partner', owner_user: 'aaaaaaaa-0000-0000-0000-000000000001' }]
    })
    const instancesChain = makeChain({ select: [] })
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settingsChain
      if (table === 'nivaro_integration_obligations') return obligationsChain
      if (table === 'nivaro_external_apis') return apisChain
      if (table === 'nivaro_workflow_instances') return instancesChain
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    await alertUnmetObligations()

    expect(notifyUser).toHaveBeenCalledTimes(1)
    const opts = vi.mocked(notifyUser).mock.calls[0][2]
    expect(opts.target).toEqual({ kind: 'integration', action: 'review' })
  })

  it('still targets the record itself for an ordinary collection', async () => {
    setApp(fakeApp)
    const settingsChain = makeChain({ first: { integration_notifications_enabled: true } })
    const obligationsChain = makeChain({ select: [row], update: 1 })
    const apisChain = makeChain({
      select: [{ name: 'Partner', owner_user: 'aaaaaaaa-0000-0000-0000-000000000001' }]
    })
    const instancesChain = makeChain({ select: [] })
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_settings') return settingsChain
      if (table === 'nivaro_integration_obligations') return obligationsChain
      if (table === 'nivaro_external_apis') return apisChain
      if (table === 'nivaro_workflow_instances') return instancesChain
      throw new Error(`unexpected table: ${table}`)
    }) as never)

    await alertUnmetObligations()

    const opts = vi.mocked(notifyUser).mock.calls[0][2]
    expect(opts.target).toEqual({
      kind: 'record',
      collection: 'workflows',
      id: '10',
      action: 'review'
    })
  })
})
