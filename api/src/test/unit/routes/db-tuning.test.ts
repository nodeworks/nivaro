import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const currentUser: { id: string; isAdmin: boolean } = { id: 'user-admin', isAdmin: true }

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: currentUser.id }
    req.isAdmin = currentUser.isAdmin
    if (!currentUser.isAdmin) {
      const err = new Error('Forbidden') as Error & { statusCode: number }
      err.statusCode = 403
      throw err
    }
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))
vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/db-tuning/apply.js', async (orig) => {
  const m = (await orig()) as Record<string, unknown>
  return {
    ...m,
    applyProposal: vi.fn(),
    rollbackProposal: vi.fn(),
    dismissProposal: vi.fn(),
    readLiveState: vi.fn(async () => ({})),
    revalidate: vi.fn(() => null)
  }
})
vi.mock('../../../services/db-tuning/ledger.js', () => ({
  getProposal: vi.fn(),
  listProposals: vi.fn(async () => []),
  updateProposal: vi.fn(async () => {})
}))
vi.mock('../../../services/db-tuning/observe-run.js', () => ({
  OBSERVE_JOB_ID: 'db-tuning-observe',
  isObserveRunning: vi.fn(() => false),
  observeRunsInFlight: vi.fn(async () => 0),
  runObserve: vi.fn()
}))
vi.mock('../../../services/db-tuning/observers/registry.js', () => ({
  listTuningObservers: vi.fn(() => [{ id: 'x:y', owner: 'x', kind: 'index_create' }])
}))
vi.mock('../../../services/db-tuning/proof.js', () => ({ prove: vi.fn() }))
vi.mock('../../../services/db-tuning/settings.js', async (orig) => {
  const m = (await orig()) as Record<string, unknown>
  return { ...m, readTuningSettings: vi.fn(), bustTuningSettings: vi.fn() }
})

import { db } from '../../../db/index.js'
import { dbTuningRoutes } from '../../../routes/db-tuning.js'
import { logActivity } from '../../../services/activity.js'
import {
  applyProposal,
  dismissProposal,
  readLiveState,
  revalidate,
  rollbackProposal,
  TuningRefusal
} from '../../../services/db-tuning/apply.js'
import { getProposal, listProposals, updateProposal } from '../../../services/db-tuning/ledger.js'
import {
  isObserveRunning,
  observeRunsInFlight,
  runObserve
} from '../../../services/db-tuning/observe-run.js'
import { prove } from '../../../services/db-tuning/proof.js'
import {
  bustTuningSettings,
  readTuningSettings,
  TUNING_DEFAULTS
} from '../../../services/db-tuning/settings.js'

function buildApp() {
  const app = Fastify({ logger: false })
  app.register(dbTuningRoutes, { prefix: '/db-tuning' })
  return app
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  kind: 'index_create',
  target: 'dbo.t',
  status: 'stale',
  title: 'Index t',
  evidence: {},
  estimate_ms_per_day: 100,
  risk: 'reversible',
  apply: { type: 'index_create' },
  undo: { type: 'index_drop' },
  replicated: false,
  ...over
})

beforeEach(() => {
  vi.clearAllMocks()
  currentUser.id = 'user-admin'
  currentUser.isAdmin = true
  vi.mocked(readTuningSettings).mockResolvedValue({ ...TUNING_DEFAULTS, enabled: true })
  vi.mocked(getProposal).mockResolvedValue(row() as never)
})

describe('db-tuning routes', () => {
  it('is admin only', async () => {
    currentUser.isAdmin = false
    const app = buildApp()
    for (const [method, url] of [
      ['GET', '/db-tuning'],
      ['GET', '/db-tuning/proposals'],
      ['POST', '/db-tuning/proposals/p1/apply'],
      ['POST', '/db-tuning/observe'],
      ['PATCH', '/db-tuning/settings']
    ] as const) {
      const res = await app.inject({ method, url, payload: {} })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
    expect(applyProposal).not.toHaveBeenCalled()
  })

  it('lists proposals with the status and kind filters, ignoring unknown values', async () => {
    const app = buildApp()
    await app.inject({
      method: 'GET',
      url: '/db-tuning/proposals?status=stale,bogus,proposed&kind=index_create'
    })
    expect(listProposals).toHaveBeenLastCalledWith({
      status: ['stale', 'proposed'],
      kind: 'index_create'
    })
    await app.inject({ method: 'GET', url: '/db-tuning/proposals?kind=nope' })
    expect(listProposals).toHaveBeenLastCalledWith({ status: ['proposed'], kind: undefined })
  })

  it('answers 404 for an unknown proposal on every id route', async () => {
    vi.mocked(getProposal).mockResolvedValue(null)
    const app = buildApp()
    for (const [method, url] of [
      ['GET', '/db-tuning/proposals/nope'],
      ['POST', '/db-tuning/proposals/nope/apply'],
      ['POST', '/db-tuning/proposals/nope/rollback'],
      ['POST', '/db-tuning/proposals/nope/dismiss'],
      ['POST', '/db-tuning/proposals/nope/reprove']
    ] as const) {
      const res = await app.inject({ method, url, payload: {} })
      expect(res.statusCode, `${method} ${url}`).toBe(404)
    }
  })

  it('applies with the caller and the dba flag', async () => {
    vi.mocked(applyProposal).mockResolvedValue(row({ status: 'watching' }) as never)
    const res = await buildApp().inject({
      method: 'POST',
      url: '/db-tuning/proposals/p1/apply',
      payload: { dba_ok: true }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data.status).toBe('watching')
    expect(applyProposal).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ userId: 'user-admin', dbaOk: true })
    )
  })

  it('maps a TuningRefusal to its status, code and detail', async () => {
    vi.mocked(applyProposal).mockRejectedValue(
      new TuningRefusal('TUNING_REPLICATED', 'needs the DBA', 409, {
        target: 'dbo.t',
        statements: ['CREATE INDEX x']
      })
    )
    const res = await buildApp().inject({
      method: 'POST',
      url: '/db-tuning/proposals/p1/apply',
      payload: {}
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({
      error: 'needs the DBA',
      code: 'TUNING_REPLICATED',
      target: 'dbo.t',
      statements: ['CREATE INDEX x']
    })
    expect(vi.mocked(applyProposal).mock.calls[0]?.[1]).toMatchObject({ dbaOk: false })
  })

  it('maps a 400 refusal on rollback and lets any other error through as a 500', async () => {
    vi.mocked(rollbackProposal).mockRejectedValueOnce(
      new TuningRefusal('TUNING_INVALID', 'bad spec', 400)
    )
    const app = buildApp()
    const bad = await app.inject({
      method: 'POST',
      url: '/db-tuning/proposals/p1/rollback',
      payload: { reason: 'slower' }
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().code).toBe('TUNING_INVALID')
    expect(rollbackProposal).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ reason: 'slower', userId: 'user-admin' })
    )

    vi.mocked(rollbackProposal).mockRejectedValueOnce(new Error('boom'))
    const boom = await app.inject({
      method: 'POST',
      url: '/db-tuning/proposals/p1/rollback',
      payload: {}
    })
    expect(boom.statusCode).toBe(500)
  })

  it('dismisses through the service only: no second activity row', async () => {
    vi.mocked(dismissProposal).mockResolvedValue(undefined)
    const res = await buildApp().inject({
      method: 'POST',
      url: '/db-tuning/proposals/p1/dismiss',
      payload: { note: 'not now' }
    })
    expect(res.statusCode).toBe(200)
    expect(dismissProposal).toHaveBeenCalledWith('p1', { userId: 'user-admin', note: 'not now' })
    expect(logActivity).not.toHaveBeenCalled()
  })

  it('reprove writes the new proof back and can make a stale row proposed again', async () => {
    vi.mocked(prove).mockResolvedValue({
      passed: true,
      method: 'hypothetical',
      before: {},
      after: {},
      detail: 'ok'
    })
    const res = await buildApp().inject({ method: 'POST', url: '/db-tuning/proposals/p1/reprove' })
    expect(res.statusCode).toBe(200)
    expect(prove).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'index_create', target: 'dbo.t' }),
      { procTimeoutMs: TUNING_DEFAULTS.proc_timeout_minutes * 60_000 }
    )
    expect(updateProposal).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        status: 'proposed',
        proof: expect.objectContaining({ passed: true })
      })
    )
  })

  it('reprove reads the live object first: a changed one stays stale and is not proved', async () => {
    const app = buildApp()
    for (const status of ['stale', 'proposed', 'rejected_by_proof']) {
      vi.mocked(updateProposal).mockClear()
      vi.mocked(getProposal).mockResolvedValue(row({ status, kind: 'proc_rewrite' }) as never)
      vi.mocked(revalidate).mockReturnValueOnce('the procedure body changed since the proof ran')
      const res = await app.inject({ method: 'POST', url: '/db-tuning/proposals/p1/reprove' })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toMatchObject({
        code: 'TUNING_STALE',
        error: 'the object changed since this was proposed; it will be re-observed tonight',
        reason: 'the procedure body changed since the proof ran'
      })
      if (status === 'stale') expect(updateProposal).not.toHaveBeenCalled()
      else expect(updateProposal).toHaveBeenCalledWith('p1', { status: 'stale' })
    }
    expect(readLiveState).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }))
    expect(prove).not.toHaveBeenCalled()
  })
  it('reprove refuses a row that is not open, and a failed proof lands as rejected_by_proof', async () => {
    const app = buildApp()
    vi.mocked(getProposal).mockResolvedValue(row({ status: 'watching' }) as never)
    const busy = await app.inject({ method: 'POST', url: '/db-tuning/proposals/p1/reprove' })
    expect(busy.statusCode).toBe(409)
    expect(prove).not.toHaveBeenCalled()

    vi.mocked(getProposal).mockResolvedValue(row() as never)
    vi.mocked(prove).mockResolvedValue({
      passed: false,
      method: 'hypothetical',
      before: {},
      after: {},
      detail: 'no gain'
    })
    await app.inject({ method: 'POST', url: '/db-tuning/proposals/p1/reprove' })
    expect(updateProposal).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ status: 'rejected_by_proof' })
    )
  })

  it('reprove leaves a proposed row alone when the proof itself errored', async () => {
    vi.mocked(getProposal).mockResolvedValue(row({ status: 'proposed' }) as never)
    vi.mocked(prove).mockResolvedValue({
      passed: false,
      method: 'refused',
      before: {},
      after: {},
      detail: 'error: proof could not run'
    })
    const res = await buildApp().inject({ method: 'POST', url: '/db-tuning/proposals/p1/reprove' })
    expect(res.statusCode).toBe(200)
    expect(updateProposal).not.toHaveBeenCalled()
  })

  it('observe dry run is awaited and answers 200 with the report', async () => {
    const report = { skipped: 'disabled', candidates: 0 }
    vi.mocked(runObserve).mockResolvedValue(report as never)
    const res = await buildApp().inject({
      method: 'POST',
      url: '/db-tuning/observe',
      payload: { dry_run: true }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().data).toEqual(report)
    expect(runObserve).toHaveBeenCalledWith({
      dryRun: true,
      trigger: 'run-now',
      userId: 'user-admin'
    })
  })

  it('observe starts a real run in the background and answers 202 started', async () => {
    let finish: (v: unknown) => void = () => {}
    vi.mocked(runObserve).mockReturnValue(new Promise((r) => (finish = r)) as never)
    const res = await buildApp().inject({ method: 'POST', url: '/db-tuning/observe', payload: {} })
    expect(res.statusCode).toBe(202)
    expect(res.json().data).toEqual({ started: true })
    expect(runObserve).toHaveBeenCalledWith({ trigger: 'run-now', userId: 'user-admin' })
    finish({})
  })

  it('observe refuses with 409 when tuning is off or a run is in progress', async () => {
    const app = buildApp()
    vi.mocked(readTuningSettings).mockResolvedValue({ ...TUNING_DEFAULTS, enabled: false })
    const off = await app.inject({ method: 'POST', url: '/db-tuning/observe', payload: {} })
    expect(off.statusCode).toBe(409)
    expect(off.json().code).toBe('TUNING_DISABLED')

    vi.mocked(readTuningSettings).mockResolvedValue({ ...TUNING_DEFAULTS, enabled: true })
    vi.mocked(isObserveRunning).mockReturnValueOnce(true)
    const busy = await app.inject({ method: 'POST', url: '/db-tuning/observe', payload: {} })
    expect(busy.statusCode).toBe(409)
    expect(busy.json().code).toBe('TUNING_RUNNING')
    // a run another process holds (its job-run row) counts too
    vi.mocked(observeRunsInFlight).mockResolvedValueOnce(1)
    const elsewhere = await app.inject({ method: 'POST', url: '/db-tuning/observe', payload: {} })
    expect(elsewhere.statusCode).toBe(409)
    expect(elsewhere.json().code).toBe('TUNING_RUNNING')
    expect(runObserve).not.toHaveBeenCalled()
  })

  it('dismiss requires a note', async () => {
    const app = buildApp()
    for (const payload of [{}, { note: '   ' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/db-tuning/proposals/p1/dismiss',
        payload
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toMatchObject({ code: 'TUNING_INVALID', error: 'A note is required' })
    }
    expect(dismissProposal).not.toHaveBeenCalled()
  })

  it('reprove writes a tuning-reprove activity row', async () => {
    vi.mocked(prove).mockResolvedValue({
      passed: false,
      method: 'hypothetical',
      before: {},
      after: {},
      detail: 'no gain'
    })
    await buildApp().inject({ method: 'POST', url: '/db-tuning/proposals/p1/reprove' })
    expect(logActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tuning-reprove',
        collection: 'nivaro_tuning_proposals',
        item: 'p1',
        comment: expect.stringContaining('hypothetical failed')
      })
    )
  })

  it('PATCH settings names every invalid key', async () => {
    const res = await buildApp().inject({
      method: 'PATCH',
      url: '/db-tuning/settings',
      payload: { watch_days: -5, regression_pct: 1000 }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().problems).toHaveLength(2)
    expect(res.json().error).toMatch(/watch_days.*regression_pct/)
  })

  it('PATCH settings rejects a bad value with 400 and writes nothing', async () => {
    const res = await buildApp().inject({
      method: 'PATCH',
      url: '/db-tuning/settings',
      payload: { watch_days: -5 }
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/watch_days/)
    expect(db).not.toHaveBeenCalled()
    expect(bustTuningSettings).not.toHaveBeenCalled()
  })

  /** nivaro_settings id 1 as stored: `first` reads the raw column, `update` writes it. */
  const settingsRow = (stored: unknown) => {
    const update = vi.fn(async () => 1)
    const first = vi.fn(async () => ({ db_tuning: stored }))
    const where = vi.fn(() => ({ update, first }))
    vi.mocked(db as unknown as (t: string) => unknown).mockReturnValue({ where })
    return { update, first }
  }

  it('PATCH settings merges onto the stored settings, writes the column and busts the cache', async () => {
    const { update } = settingsRow(JSON.stringify({ enabled: true, regression_pct: 40 }))
    const res = await buildApp().inject({
      method: 'PATCH',
      url: '/db-tuning/settings',
      payload: { watch_days: 3 }
    })
    expect(res.statusCode).toBe(200)
    const want = { ...TUNING_DEFAULTS, enabled: true, regression_pct: 40, watch_days: 3 }
    expect(res.json().data).toEqual(want)
    expect(update).toHaveBeenCalledWith({ db_tuning: JSON.stringify(want) })
    expect(bustTuningSettings).toHaveBeenCalled()
  })

  it('PATCH settings never copies an instance override into the shared row', async () => {
    // this instance runs with db_tuning.enabled overridden on; the shared row says off
    vi.mocked(readTuningSettings).mockResolvedValue({ ...TUNING_DEFAULTS, enabled: true })
    const { update } = settingsRow(JSON.stringify({ enabled: false }))
    const res = await buildApp().inject({
      method: 'PATCH',
      url: '/db-tuning/settings',
      payload: { watch_days: 3 }
    })
    expect(res.statusCode).toBe(200)
    expect(update).toHaveBeenCalledWith({
      db_tuning: JSON.stringify({ ...TUNING_DEFAULTS, enabled: false, watch_days: 3 })
    })
  })

  it('PATCH settings reads an unset, unparseable or invalid stored value as the defaults', async () => {
    for (const stored of [null, '', '{not json', '[1]', JSON.stringify({ watch_days: 99 })]) {
      const { update } = settingsRow(stored)
      const res = await buildApp().inject({
        method: 'PATCH',
        url: '/db-tuning/settings',
        payload: { regression_pct: 30 }
      })
      expect(res.statusCode).toBe(200)
      expect(update).toHaveBeenCalledWith({
        db_tuning: JSON.stringify({ ...TUNING_DEFAULTS, regression_pct: 30 })
      })
    }
  })

  it('GET overview rolls up counts by status and kind with the observers', async () => {
    const grouped = Object.assign(
      Promise.resolve([
        { status: 'proposed', kind: 'index_create', est: 300, n: 2 },
        { status: 'proposed', kind: 'index_drop', est: 50, n: 1 },
        { status: 'dismissed', kind: 'index_create', est: 10, n: 4 }
      ]),
      {}
    )
    const jobRuns = {
      where: () => jobRuns,
      orderBy: () => jobRuns,
      first: () => Promise.resolve({ status: 'completed' })
    }
    const applied = {
      whereIn: () => applied,
      where: () => applied,
      count: () => applied,
      first: () => Promise.resolve({ n: 3 })
    }
    const proposals = {
      select: () => proposals,
      sum: () => proposals,
      count: () => proposals,
      groupBy: () => grouped,
      whereIn: () => applied,
      where: () => applied
    }
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((t: string) =>
      t === 'nivaro_job_runs' ? jobRuns : proposals
    )
    const res = await buildApp().inject({ method: 'GET', url: '/db-tuning' })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d.by_status).toEqual({ proposed: 3, dismissed: 4 })
    expect(d.by_kind).toEqual({ index_create: 2, index_drop: 1 })
    expect(d.open_estimate_ms_per_day).toBe(350)
    expect(d.applied_30d).toBe(3)
    expect(d.last_run).toEqual({ status: 'completed' })
    expect(d.is_running).toBe(false)
    expect(d.observers).toHaveLength(1)
  })
})
