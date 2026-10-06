import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  db: null as any,
  user: { id: 'ADMIN-1', isAdmin: true }
}))

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: h.user.id }
    req.isAdmin = h.user.isAdmin
    if (!h.user.isAdmin) {
      const err = new Error('Forbidden') as Error & { statusCode: number }
      err.statusCode = 403
      throw err
    }
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../db/index.js', () => ({
  db: new Proxy(() => {}, {
    apply: (_t, _this, args: unknown[]) => h.db(...args),
    get: (_t, p) => h.db[p]
  })
}))
vi.mock('../../../extensions/loader.js', () => ({
  extensionRunbooks: new Map([
    [
      'efp-ops',
      [
        {
          key: 'quality-rerun',
          label: 'Re-run quality checks',
          runs_on: 'host',
          command: ['bash', 'extensions/efp-ops/scripts/quality-rerun.sh'],
          dry_args: [],
          go_args: [],
          target_env: 'TARGET',
          refuse_targets: ['EFP', 'EFP_Development'],
          skip_dry_gate: true
        },
        {
          key: 'staging-rebuild',
          label: 'Rebuild',
          runs_on: 'host',
          command: ['bash', 'extensions/efp-ops/scripts/golive-cron.sh'],
          dry_args: ['--dry'],
          go_args: [],
          target_env: 'TARGET',
          refuse_targets: ['EFP', 'EFP_Development']
        }
      ]
    ]
  ])
}))

import { createTestDb } from '@nivaro/extension-kit'
import { qualityCheckRoutes } from '../../../routes/quality-checks.js'
import { logActivity } from '../../../services/activity.js'
import { encodeRows } from '../../../services/quality/store.js'

const RUN = '11111111-2222-3333-4444-555555555555'
const CHECK = 'owners.workflows'

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  h.db = createTestDb({
    tables: {
      nivaro_quality_runs: [
        {
          id: RUN,
          target: 'EFP_Staging',
          status: 'done',
          started_at: new Date('2026-10-06T02:00:00Z'),
          captured_at: new Date('2026-10-06T02:10:00Z'),
          verified_at: new Date('2026-10-06T05:00:00Z'),
          totals: JSON.stringify({ green: 0, amber: 0, red: 1, error: 0 }),
          runbook_run: null,
          error: null
        }
      ],
      nivaro_quality_rows: [
        {
          id: 1,
          run: RUN,
          check_id: CHECK,
          side: 'baseline',
          rows_gz: encodeRows([{ key: 'w:1', values: { o: 'a' } }]),
          row_count: 1,
          error: null
        },
        {
          id: 2,
          run: RUN,
          check_id: CHECK,
          side: 'current',
          rows_gz: encodeRows([{ key: 'w:1', values: { o: 'b' } }]),
          row_count: 1,
          error: null
        }
      ],
      nivaro_quality_results: [
        {
          id: 1,
          run: RUN,
          check_id: CHECK,
          area: 'owners',
          label: 'Workflow owners',
          description: 'd',
          status: 'red',
          tolerance: null,
          compared: 1,
          matched: 0,
          amber_count: 0,
          red_count: 1,
          baseline_only: 0,
          current_only: 0,
          duration_ms: 5,
          error: null,
          clusters: '[]',
          rows: JSON.stringify([{ key: 'w:1', status: 'mismatch', fields: ['o'] }])
        },
        {
          id: 2,
          run: RUN,
          check_id: 'counts.workflows',
          area: 'counts',
          label: 'Workflow count',
          description: 'd',
          status: 'green',
          compared: 1,
          matched: 1,
          amber_count: 0,
          red_count: 0,
          baseline_only: 0,
          current_only: 0,
          duration_ms: 1,
          error: null,
          clusters: '[]',
          rows: '[]'
        }
      ],
      nivaro_quality_known: [],
      nivaro_runbook_queue: [],
      ...extra
    }
  })
}

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(qualityCheckRoutes, { prefix: '/quality-checks' })
  return app
}

const result = () =>
  (h.db.state.tables.nivaro_quality_results as Record<string, unknown>[]).find(
    (r) => r.run === RUN && r.check_id === CHECK
  )

beforeEach(() => {
  h.user.isAdmin = true
  vi.mocked(logActivity).mockClear()
  seed()
})

describe('quality-check routes', () => {
  it('rejects non-admins', async () => {
    h.user.isAdmin = false
    const res = await buildApp().inject({ method: 'GET', url: '/quality-checks/runs' })
    expect(res.statusCode).toBe(403)
  })

  it('lists runs and a run with its results in area order', async () => {
    const app = buildApp()
    const list = await app.inject({ method: 'GET', url: '/quality-checks/runs?target=EFP_Staging' })
    expect(list.statusCode).toBe(200)
    expect(list.json().data).toHaveLength(1)
    expect(list.json().data[0].totals).toEqual({ green: 0, amber: 0, red: 1, error: 0 })
    const one = await app.inject({ method: 'GET', url: `/quality-checks/runs/${RUN}` })
    expect(one.statusCode).toBe(200)
    const results = one.json().data.results
    expect(results.map((r: { check_id: string }) => r.check_id)).toEqual([
      CHECK,
      'counts.workflows'
    ])
    expect(results[0].rows).toBeUndefined()
    expect(results[0].clusters).toBeUndefined()
  })

  it('marking expected re-diffs the stored run', async () => {
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/quality-checks/known',
      payload: { check_id: CHECK, match: { key: 'w:1' }, reason: 'teams', run: RUN }
    })
    expect(res.statusCode).toBe(200)
    expect(typeof res.json().data.id).toBe('number')
    expect(res.json().data.rediffed).toBe(true)
    expect(result()).toMatchObject({ status: 'amber', amber_count: 1, red_count: 0 })
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'quality-known-create', comment: 'teams' })
    )
    const detail = await app.inject({
      method: 'GET',
      url: `/quality-checks/runs/${RUN}/checks/${CHECK}`
    })
    expect(detail.json().data.result.rows[0]).toMatchObject({ key: 'w:1', expected: true })
    expect(detail.json().data.known).toHaveLength(1)

    // Removing it turns the latest FINISHED run red again — a newer run that is
    // still capturing (no results yet) is not the one re-diffed.
    h.db.state.tables.nivaro_quality_runs.push({
      id: '99999999-2222-3333-4444-555555555555',
      target: 'EFP_Staging',
      status: 'capturing',
      started_at: new Date('2026-10-07T02:00:00Z')
    })
    const id = res.json().data.id
    const del = await app.inject({ method: 'DELETE', url: `/quality-checks/known/${id}` })
    expect(del.statusCode).toBe(200)
    expect(del.json().data).toEqual({ id, rediffed: true })
    expect(result()).toMatchObject({ status: 'red', amber_count: 0, red_count: 1 })
    const capturing = h.db.state.tables.nivaro_quality_runs.find(
      (r: Record<string, unknown>) => r.status === 'capturing'
    )
    expect(capturing.totals).toBeUndefined()
  })

  it('leaves a run being verified to its runner and says so', async () => {
    h.db.state.tables.nivaro_quality_runs[0].status = 'verifying'
    const app = buildApp()
    const res = await app.inject({
      method: 'POST',
      url: '/quality-checks/known',
      payload: { check_id: CHECK, match: { key: 'w:1' }, reason: 'teams', run: RUN }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.rediffed).toBe(false)
    expect(result()).toMatchObject({ status: 'red' })
    const patch = await app.inject({
      method: 'PATCH',
      url: `/quality-checks/known/${res.json().data.id}`,
      payload: { reason: 'teams again' }
    })
    expect(patch.json().data.rediffed).toBe(false)
    const noRun = await app.inject({
      method: 'POST',
      url: '/quality-checks/known',
      payload: { check_id: CHECK, match: { field: 'o' }, reason: 'teams' }
    })
    expect(noRun.json().data.rediffed).toBe(false)
  })

  it('refuses a known difference with no condition', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/quality-checks/known',
      payload: { check_id: CHECK, match: {}, reason: 'teams' }
    })
    expect(res.statusCode).toBe(400)
    expect(h.db.state.tables.nivaro_quality_known).toHaveLength(0)
  })

  it('refuses a bad check id, a short reason and an oversized cluster', async () => {
    const app = buildApp()
    for (const payload of [
      { check_id: 'Owners!', match: { key: 'a' }, reason: 'teams' },
      { check_id: CHECK, match: { key: 'a' }, reason: 'no' },
      {
        check_id: CHECK,
        match: { cluster: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`k${n}`, 'v'])) },
        reason: 'teams'
      },
      { check_id: CHECK, match: { field: 'x'.repeat(101) }, reason: 'teams' },
      { check_id: CHECK, match: { key: 'a*b*c*d*e*f' }, reason: 'teams' }
    ]) {
      const res = await app.inject({ method: 'POST', url: '/quality-checks/known', payload })
      expect(res.statusCode).toBe(400)
    }
  })

  it('accepts up to four wildcards in a key and names the limit beyond it', async () => {
    const app = buildApp()
    const ok = await app.inject({
      method: 'POST',
      url: '/quality-checks/known',
      payload: { check_id: CHECK, match: { key: 'w:*:*:*:*' }, reason: 'teams' }
    })
    expect(ok.statusCode).toBe(200)
    const no = await app.inject({
      method: 'POST',
      url: '/quality-checks/known',
      payload: { check_id: CHECK, match: { key: '*:*:*:*:*' }, reason: 'teams' }
    })
    expect(no.statusCode).toBe(400)
    expect(no.json().error).toBe('match.key may use * at most 4 times')
  })

  it('downloads every non-matching row as CSV', async () => {
    const app = buildApp()
    await app.inject({
      method: 'POST',
      url: '/quality-checks/known',
      payload: { check_id: CHECK, match: { key: 'w:1' }, reason: 'teams', run: RUN }
    })
    const res = await app.inject({
      method: 'GET',
      url: `/quality-checks/runs/${RUN}/checks/${CHECK}/csv`
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/csv/)
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="quality-${CHECK}-20261006.csv"`
    )
    const lines = res.body.trim().split('\n')
    expect(lines[0]).toBe('key,label,status,expected,fields,production,staging,reason')
    expect(lines[1]).toContain('"w:1"')
    expect(lines[1]).toContain('"teams"')
  })

  it('refuses rerun while a rebuild is queued for the target', async () => {
    seed({
      nivaro_runbook_queue: [
        {
          id: 'Q1',
          extension: 'efp-ops',
          runbook: 'staging-rebuild',
          mode: 'go',
          target: 'EFP_Staging',
          status: 'queued',
          requested_at: new Date()
        }
      ]
    })
    const res = await buildApp().inject({
      method: 'POST',
      url: '/quality-checks/rerun',
      payload: { target: 'EFP_Staging', runbook: { extension: 'efp-ops', key: 'quality-rerun' } }
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({
      error: 'A rebuild is running — re-run after it finishes',
      code: 'QUALITY_RERUN_BUSY'
    })
    expect(h.db.state.tables.nivaro_runbook_queue).toHaveLength(1)
  })

  it('queues a re-run as a real host run without a dry run', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/quality-checks/rerun',
      payload: { target: 'EFP_Staging', runbook: { extension: 'efp-ops', key: 'quality-rerun' } }
    })
    expect(res.statusCode).toBe(201)
    const rows = h.db.state.tables.nivaro_runbook_queue as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      extension: 'efp-ops',
      runbook: 'quality-rerun',
      mode: 'go',
      target: 'EFP_Staging',
      status: 'queued',
      requested_by: 'ADMIN-1'
    })
  })

  it('refuses a re-run the admission check refuses', async () => {
    const app = buildApp()
    const prod = await app.inject({
      method: 'POST',
      url: '/quality-checks/rerun',
      payload: { target: 'EFP', runbook: { extension: 'efp-ops', key: 'quality-rerun' } }
    })
    expect(prod.statusCode).toBe(400)
    // A runbook without skip_dry_gate (a rebuild) is never queued from here.
    const rebuild = await app.inject({
      method: 'POST',
      url: '/quality-checks/rerun',
      payload: { target: 'EFP_Staging', runbook: { extension: 'efp-ops', key: 'staging-rebuild' } }
    })
    expect(rebuild.statusCode).toBe(400)
    expect(h.db.state.tables.nivaro_runbook_queue).toHaveLength(0)
  })
})
