import type { FastifyBaseLogger } from 'fastify'
import type { Knex } from 'knex'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub shared deployments, Task 6: the daily retention pass runs per app. Two apps A and B are
// COPIES (same tables, same settings shape, same journey rows); the pass run inside A reads A's
// settings and deletes only A's expired rows, B's stay until B's own run. The help-video import
// sweep (process memory + the work dir on disk) is never part of an app's pass. Self-hosted keeps
// the one chain with the sweep in its old place.

const DAY = 86_400_000

type Row = Record<string, unknown>
interface Rec {
  tenant: string
  table: string
  ops: Array<[string, unknown[]]>
}

const h = vi.hoisted(() => ({
  calls: [] as Array<{ tenant: string; step: string }>,
  queries: [] as Rec[],
  data: new Map<string, Map<string, Row[]>>(),
  settings: new Map<string, Row>(),
  failTrash: false
}))

vi.mock('../../../db/index.js', async () => {
  const { getTenantId } = await import('../../../db/tenant-context.js')
  function resolve(rec: Rec): unknown {
    const rows = h.data.get(rec.tenant)?.get(rec.table) ?? []
    const op = (name: string) => rec.ops.find(([n]) => n === name)
    if (rec.table === 'nivaro_settings' && op('first')) return h.settings.get(rec.tenant) ?? null
    if (op('del') || op('delete')) {
      const where = op('where')
      if (!where) return 0
      const [col, cmp, val] = where[1] as [string, string, Date]
      const keep = rows.filter((r) => !(cmp === '<' && (r[col] as Date) < val))
      h.data.get(rec.tenant)?.set(rec.table, keep)
      return rows.length - keep.length
    }
    return []
  }
  const db = (table: string) => {
    const rec: Rec = { tenant: getTenantId() ?? '', table, ops: [] }
    h.queries.push(rec)
    const builder: Record<string | symbol, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then' || prop === 'catch' || prop === 'finally') {
            const p = Promise.resolve().then(() => resolve(rec))
            return (p[prop as 'then'] as (...a: unknown[]) => unknown).bind(p)
          }
          return (...args: unknown[]) => {
            rec.ops.push([String(prop), args])
            return builder
          }
        }
      }
    )
    return builder
  }
  return { db }
})

async function step(name: string, out: unknown = 0) {
  const { getTenantId } = await import('../../../db/tenant-context.js')
  h.calls.push({ tenant: getTenantId() ?? '', step: name })
  return out
}
vi.mock('../../../services/job-runs.js', () => ({ pruneJobRuns: () => step('pruneJobRuns') }))
vi.mock('../../../services/activity-trail/purge.js', () => ({
  purgeActivityRows: () => step('purgeActivityRows', { deleted: 4, bridged: 1 })
}))
vi.mock('../../../services/revision-retention.js', () => ({
  pruneRevisionsByCount: () => step('pruneRevisionsByCount')
}))
vi.mock('../../../services/trash.js', () => ({
  purgeExpiredTrash: async () => {
    await step('purgeExpiredTrash')
    if (h.failTrash) throw new Error('boom')
    return 0
  }
}))
vi.mock('../../../routes/session-recordings.js', () => ({
  purgeExpiredRecordings: () => step('purgeExpiredRecordings', undefined)
}))
vi.mock('../../../services/help-video-uploads.js', () => ({
  purgeStaleUploads: () => step('purgeStaleUploads')
}))
vi.mock('../../../services/help-video-render.js', () => ({
  pruneOldRenders: () => step('pruneOldRenders')
}))
vi.mock('../../../services/help-video-package.js', () => ({
  purgeStaleImports: () => step('purgeStaleImports')
}))
vi.mock('../../../services/erp-retention.js', () => ({
  pruneErpSubmissionPayloads: () =>
    step('pruneErpSubmissionPayloads', { blanked: 0, days: 90, more: false })
}))
vi.mock('../../../services/integration-obligations.js', () => ({
  pruneObligations: () => step('pruneObligations')
}))
vi.mock('../../../services/ai-log.js', () => ({ pruneAiCalls: () => step('pruneAiCalls') }))
vi.mock('../../../services/ai-conversations.js', () => ({
  pruneConversations: () => step('pruneConversations')
}))
vi.mock('../../../services/chat-send.js', () => ({
  pruneChatMessageHistory: () => step('pruneChatMessageHistory')
}))

const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const { RETENTION_PASS_CRON, runAppRetentionPass, runSelfHostedRetentionPass } = await import(
  '../../../services/retention-pass.js'
)
const { noteRetentionPassScheduled, retentionPassSchedule } = await import(
  '../../../services/retention-schedule.js'
)
const { CORE_CRON_SCOPES, SELF_HOSTED_ONLY_CRONS } = await import('../../../services/cron-scope.js')
const { CRON_DESCRIPTIONS } = await import('../../../services/cron-descriptions.js')

const log = { info: vi.fn(), warn: vi.fn() } as unknown as FastifyBaseLogger

function inApp<T>(app: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((res, rej) => {
    runWithTenantDb({} as Knex, app, () => void fn().then(res, rej), app)
  })
}

const APP_STEPS = [
  'pruneJobRuns',
  'purgeActivityRows',
  'pruneRevisionsByCount',
  'purgeExpiredTrash',
  'purgeExpiredRecordings',
  'purgeStaleUploads',
  'pruneOldRenders',
  'pruneErpSubmissionPayloads',
  'pruneObligations',
  'pruneAiCalls',
  'pruneConversations',
  'pruneChatMessageHistory'
]

function seed(app: string) {
  const old = new Date(Date.now() - 45 * DAY)
  const fresh = new Date(Date.now() - 2 * DAY)
  h.data.set(
    app,
    new Map([
      [
        'nivaro_admin_journeys',
        [
          { id: 1, entered_at: old },
          { id: 2, entered_at: fresh }
        ]
      ]
    ])
  )
  h.settings.set(app, { activity_retention_days: 30, revision_retention_count: 20 })
}

beforeEach(() => {
  h.calls.length = 0
  h.queries.length = 0
  seed('A')
  seed('B')
})

describe('runAppRetentionPass inside one app', () => {
  it("deletes only that app's expired rows; the copy keeps its own until its run", async () => {
    const r = await inApp('A', () => runAppRetentionPass(log))
    expect(r).toEqual({ activity_deleted: 4, activity_bridged: 1 })
    // A's expired journey row went, B's identical copy is untouched
    expect(
      h.data
        .get('A')
        ?.get('nivaro_admin_journeys')
        ?.map((x) => x.id)
    ).toEqual([2])
    expect(
      h.data
        .get('B')
        ?.get('nivaro_admin_journeys')
        ?.map((x) => x.id)
    ).toEqual([1, 2])
    // every step and every query ran inside A
    expect(new Set(h.calls.map((c) => c.tenant))).toEqual(new Set(['A']))
    expect(new Set(h.queries.map((q) => q.tenant))).toEqual(new Set(['A']))

    h.calls.length = 0
    await inApp('B', () => runAppRetentionPass(log))
    expect(
      h.data
        .get('B')
        ?.get('nivaro_admin_journeys')
        ?.map((x) => x.id)
    ).toEqual([2])
    expect(new Set(h.calls.map((c) => c.tenant))).toEqual(new Set(['B']))
  })

  it('runs every app step in order and never the process import sweep', async () => {
    await inApp('A', () => runAppRetentionPass(log))
    const steps = h.calls.map((c) => c.step).filter((s) => s !== 'purgeActivityRows')
    expect(steps).toEqual(APP_STEPS.filter((s) => s !== 'purgeActivityRows'))
    expect(steps).not.toContain('purgeStaleImports')
  })

  // fresh copies: pass status is held per app for the life of the process
  it("keeps each app's pass status apart (last run, result, next run)", async () => {
    seed('C')
    seed('D')
    await inApp('C', () => runAppRetentionPass(log))
    const a = await inApp('C', async () => retentionPassSchedule())
    const b = await inApp('D', async () => retentionPassSchedule())
    expect(a.last_run_at).not.toBeNull()
    expect(a.last_result).toEqual({ activity_deleted: 4, activity_bridged: 1 })
    expect(b).toEqual({ last_run_at: null, next_run_at: null, last_result: null })
    await inApp('D', async () => noteRetentionPassScheduled(new Date('2026-11-24T03:30:00Z')))
    expect((await inApp('C', async () => retentionPassSchedule())).next_run_at).toBeNull()
  })

  it('a failed step ends the pass with the error noted for that app only', async () => {
    seed('E')
    seed('F')
    h.failTrash = true
    const r = await inApp('E', () => runAppRetentionPass(log)).finally(() => {
      h.failTrash = false
    })
    expect(r.error).toBe('boom')
    expect((await inApp('E', async () => retentionPassSchedule())).last_result?.error).toBe('boom')
    expect((await inApp('F', async () => retentionPassSchedule())).last_result).toBeNull()
    // the steps after the failed one did not run (as before: one try around the pass)
    expect(h.calls.map((c) => c.step)).not.toContain('purgeExpiredRecordings')
  })
})

describe('self-hosted retention pass', () => {
  it('is the app pass plus the import sweep in its old place (after renders, before ERP)', async () => {
    h.settings.set('', { activity_retention_days: 30, revision_retention_count: 20 })
    h.data.set('', new Map())
    await runSelfHostedRetentionPass(log)
    const steps = h.calls.map((c) => c.step).filter((s) => s !== 'purgeActivityRows')
    const want = APP_STEPS.filter((s) => s !== 'purgeActivityRows')
    want.splice(want.indexOf('pruneOldRenders') + 1, 0, 'purgeStaleImports')
    expect(steps).toEqual(want)
    expect(new Set(h.calls.map((c) => c.tenant))).toEqual(new Set(['']))
  })
})

describe('the retention-pass job', () => {
  it('fans out per app on a shared deployment and is described', () => {
    expect(CORE_CRON_SCOPES['retention-pass']).toBe('app')
    expect(SELF_HOSTED_ONLY_CRONS['retention-pass']).toBeUndefined()
    expect(RETENTION_PASS_CRON).toBe('30 3 * * *')
    expect(CRON_DESCRIPTIONS['retention-pass']).toMatch(/shared deployments only/)
  })
})
