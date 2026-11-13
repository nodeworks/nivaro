import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// An erp_submit push writes its submission row BEFORE the partner call (status
// `sending`) and finishes that same row with the answer. A process that stops
// mid-call leaves the row `sending`, and that row holds the next send of the
// same push on the record until a person says what the partner did.

type Row = Record<string, unknown>

const store = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  nextId: 100,
  failSubmissionUpdate: false,
  /** The guard's read of earlier sends fails (the joined read of nivaro_erp_submissions). */
  failSendingRead: false,
  /** What the submissions table held while the partner call was in flight. */
  seenDuringCall: [] as Array<Record<string, unknown>>
}))

function query(name: string) {
  const table = name.split(/\s+as\s+/i)[0]
  if (!store.tables[table]) store.tables[table] = []
  const rows = store.tables[table]
  const filters: Array<(r: Row) => boolean> = []
  let order: { col: string; dir: string } | null = null
  let cap = Number.POSITIVE_INFINITY
  let joinApis = false
  const bare = (c: string) => c.replace(/^\w+\./, '')
  const matched = () => {
    let out = rows.filter((r) => filters.every((f) => f(r)))
    if (order) {
      const { col, dir } = order
      out = [...out].sort((a, b) => (Number(a[col]) - Number(b[col])) * (dir === 'desc' ? -1 : 1))
    }
    return out.slice(0, cap).map((r) => {
      if (!joinApis) return { ...r }
      const api = (store.tables.nivaro_external_apis ?? []).find((a) => a.id === r.external_api)
      return { ...r, api_name: api?.name ?? null }
    })
  }
  const q: Record<string, unknown> = {
    where(a: unknown, op?: unknown, val?: unknown) {
      if (a && typeof a === 'object') {
        for (const [k, v] of Object.entries(a as Row))
          filters.push((r) => String(r[bare(k)]) === String(v))
      } else if (val !== undefined) {
        filters.push(() => true)
      } else filters.push((r) => String(r[bare(String(a))]) === String(op))
      return q
    },
    whereIn(col: string, vals: unknown[]) {
      filters.push((r) => vals.includes(r[bare(col)]))
      return q
    },
    whereNull(col: string) {
      filters.push((r) => r[bare(col)] == null)
      return q
    },
    leftJoin(other: string) {
      if (other.startsWith('nivaro_external_apis')) joinApis = true
      return q
    },
    orWhere: () => q,
    orderBy(col: string, dir = 'asc') {
      order = { col: bare(col), dir }
      return q
    },
    limit(n: number) {
      cap = n
      return q
    },
    select: async () => {
      if (table === 'nivaro_erp_submissions' && joinApis && store.failSendingRead)
        throw new Error('Timeout: Request failed to complete in 15000ms')
      return matched()
    },
    first: async () => matched()[0],
    insert: (row: Row) => ({
      returning: async () => {
        const id = store.nextId++
        rows.push({ ...row, id })
        return [{ id }]
      }
    }),
    update: async (patch: Row) => {
      if (table === 'nivaro_erp_submissions' && store.failSubmissionUpdate && 'status' in patch)
        throw new Error('connection lost')
      const hit = rows.filter((r) => filters.every((f) => f(r)))
      for (const r of hit) Object.assign(r, patch)
      return hit.length
    },
    // biome-ignore lint/suspicious/noThenProperty: knex builders are thenables
    then: (ok: (v: unknown) => unknown, fail?: (e: unknown) => unknown) =>
      Promise.resolve(matched()).then(ok, fail)
  }
  return q
}

vi.mock('../../../db/index.js', () => {
  const db = (name: string) => query(name)
  ;(db as unknown as { schema: unknown }).schema = { hasColumn: async () => false }
  return { db }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/integration-remediation.js', () => ({
  classifyError: vi.fn(() => 'validation')
}))
vi.mock('../../../services/external-apis.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/external-apis.js')>()),
  callExternalApi: vi.fn(async () => {
    store.seenDuringCall = (store.tables.nivaro_erp_submissions ?? []).map((r) => ({ ...r }))
    return { status: 200, body: { status: 'SUCCESS', orderNumber: 'SO-1' }, ok: true }
  })
}))
vi.mock('../../../services/integration-obligations.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../services/integration-obligations.js')>()
  return {
    ...actual,
    openObligationForTrigger: vi.fn(async () => 77),
    resolveObligation: vi.fn(async () => undefined)
  }
})

import { callExternalApi } from '../../../services/external-apis.js'
import { resolveObligation } from '../../../services/integration-obligations.js'
import { runTransitionActions } from '../../../services/workflow-actions.js'

const NOW = new Date('2026-11-12T20:00:00Z')

const action = {
  type: 'erp_submit',
  external_api: 'MDSi',
  endpoint_path: '/orders',
  payload_template: '{"ref": "{{ record.id }}"}',
  blocking: true
}

function submissions() {
  return store.tables.nivaro_erp_submissions ?? []
}

/** A row another run left behind, `minutesAgo` old. */
function sendingRow(over: Row = {}, minutesAgo = 1): Row {
  const created = new Date(NOW.getTime() - minutesAgo * 60_000)
  return {
    id: 50,
    collection: 'inventory_request',
    item: 'r1',
    external_api: 5,
    status: 'sending',
    created_at: created,
    payload: JSON.stringify({
      endpoint_path: '/orders',
      body: { ref: 'r1' },
      secret_paths: [],
      answer_by: new Date(created.getTime() + 180_000).toISOString()
    }),
    ...over
  }
}

async function run(a: Record<string, unknown> = action) {
  return runTransitionActions({
    transition: { id: 't1', label: 'Submit to Warehouse', actions: JSON.stringify([a]) },
    instance: { collection: 'inventory_request', item: 'r1' },
    newStateObj: { key: 'submitted', label: 'Submitted' },
    userId: null
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  store.tables = {
    nivaro_external_apis: [{ id: 5, name: 'MDSi' }],
    inventory_request: [{ id: 'r1', status: 'approved' }]
  }
  store.nextId = 100
  store.failSubmissionUpdate = false
  store.failSendingRead = false
  store.seenDuringCall = []
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('the submission row is written before the partner call', () => {
  it('stores ONE row: `sending` while the call is in flight, finished in place with the answer', async () => {
    const res = await run()
    expect(res.blockedError).toBeNull()
    // While the partner was being called, the row already existed and said so.
    expect(store.seenDuringCall).toHaveLength(1)
    expect(store.seenDuringCall[0]).toMatchObject({ status: 'sending', attempts: 1 })
    const payload = JSON.parse(String(store.seenDuringCall[0].payload))
    expect(payload).toMatchObject({
      endpoint_path: '/orders',
      body: { ref: 'r1' },
      secret_paths: []
    })
    // answer_by = start + the action's timeout (120 s default) + the margin (60 s).
    expect(payload.answer_by).toBe(new Date(NOW.getTime() + 180_000).toISOString())
    // …and afterwards there is still exactly one row, finished.
    expect(submissions()).toHaveLength(1)
    const [row] = submissions()
    expect(row.id).toBe(store.seenDuringCall[0].id)
    expect(row).toMatchObject({ status: 'accepted', last_error: null, obligation_id: 77 })
    expect(String(row.response)).toContain('SO-1')
    // The obligation is resolved against that same row.
    expect(resolveObligation).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ outcome: 'sent', submission_id: row.id })
    )
  })

  it('a failed answer finishes the same row as failed', async () => {
    vi.mocked(callExternalApi).mockResolvedValueOnce({
      status: 400,
      body: { message: 'Primary Reference Number already exists' },
      ok: false
    } as never)
    const res = await run()
    expect(res.blockedError).toMatch(/^Submit to Warehouse: submission failed — HTTP 400/)
    expect(submissions()).toHaveLength(1)
    expect(submissions()[0]).toMatchObject({ status: 'failed', error_class: 'validation' })
  })

  it('when finishing the row fails, the row stays `sending` (the point of writing it first)', async () => {
    store.failSubmissionUpdate = true
    await run()
    expect(submissions()).toHaveLength(1)
    expect(submissions()[0].status).toBe('sending')
  })

  it('a process that stops mid-call leaves the row `sending`', async () => {
    vi.mocked(callExternalApi).mockImplementationOnce(() => new Promise(() => {}))
    void run()
    await vi.waitFor(() => expect(callExternalApi).toHaveBeenCalled())
    expect(submissions()).toHaveLength(1)
    expect(submissions()[0].status).toBe('sending')
  })
})

describe('an unanswered send holds the next send of the same push', () => {
  it('a young one (inside its timeout): refused as still being sent, nothing sent', async () => {
    store.tables.nivaro_erp_submissions = [sendingRow({}, 1)]
    const res = await run()
    expect(callExternalApi).not.toHaveBeenCalled()
    expect(res.blockedError).toBe(
      'Submit to Warehouse: Submit to Warehouse is still being sent to MDSi (started 60 seconds ago). Wait for it to finish.'
    )
    expect(res.blockedClass).toBe('in_flight')
    expect(submissions()).toHaveLength(1)
  })

  it('a stale one (past its timeout): refused as "may already have this order"', async () => {
    store.tables.nivaro_erp_submissions = [sendingRow({}, 30)]
    const res = await run()
    expect(callExternalApi).not.toHaveBeenCalled()
    expect(res.blockedError).toMatch(
      /^Submit to Warehouse: MDSi may already have this order: the last send on .+ got no answer before the app stopped\. Check MDSi before sending again, then mark that send as received or not received in Integrations, ERP submissions\.$/
    )
    expect(res.blockedClass).toBe('unanswered')
    // The obligation records why nothing was sent.
    expect(resolveObligation).toHaveBeenCalledWith(
      77,
      expect.objectContaining({
        outcome: 'skipped',
        reason: expect.stringContaining('may already')
      })
    )
  })

  it('a different endpoint of the same API does not hold it', async () => {
    store.tables.nivaro_erp_submissions = [
      sendingRow({
        payload: JSON.stringify({ endpoint_path: '/shipments', body: {}, secret_paths: [] })
      })
    ]
    const res = await run()
    expect(res.blockedError).toBeNull()
    expect(callExternalApi).toHaveBeenCalledTimes(1)
  })

  it('another API does not hold it', async () => {
    store.tables.nivaro_external_apis.push({ id: 6, name: 'Fusion' })
    store.tables.nivaro_erp_submissions = [sendingRow({ external_api: 6 })]
    const res = await run()
    expect(res.blockedError).toBeNull()
    expect(callExternalApi).toHaveBeenCalledTimes(1)
  })

  it("a run's own unfinished row does not hold its next push to the same endpoint", async () => {
    store.failSubmissionUpdate = true
    const res = await runTransitionActions({
      transition: {
        id: 't1',
        label: 'Submit to Warehouse',
        actions: JSON.stringify([action, { ...action, blocking: true }])
      },
      instance: { collection: 'inventory_request', item: 'r1' },
      newStateObj: null,
      userId: null
    })
    expect(res.blockedError).toBeNull()
    expect(callExternalApi).toHaveBeenCalledTimes(2)
  })

  it('a finished (failed) row does not hold anything', async () => {
    store.tables.nivaro_erp_submissions = [sendingRow({ status: 'failed' }, 30)]
    const res = await run()
    expect(res.blockedError).toBeNull()
    expect(callExternalApi).toHaveBeenCalledTimes(1)
  })

  it('a non-blocking push is skipped with the reason on the obligation ledger', async () => {
    store.tables.nivaro_erp_submissions = [sendingRow({}, 30)]
    const res = await run({ ...action, blocking: false })
    expect(res.blockedError).toBeNull()
    expect(callExternalApi).not.toHaveBeenCalled()
    expect(res.skippedReason).toMatch(/^MDSi may already have this order/)
    expect(resolveObligation).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ outcome: 'skipped', reason: expect.stringMatching(/^MDSi may/) })
    )
  })
})

describe('when the earlier sends cannot be read', () => {
  it('a blocking push fails closed: refused as a blocked move, nothing sent', async () => {
    store.failSendingRead = true
    const res = await run()
    expect(callExternalApi).not.toHaveBeenCalled()
    expect(res.blockedError).toBe(
      "Submit to Warehouse: Couldn't check earlier sends to MDSi. Try again in a minute."
    )
    // Not one the automatic engine retries on its own (auto-transition-memory RETRYABLE).
    expect(res.blockedClass).toBe('check_failed')
    expect(submissions()).toHaveLength(0)
  })

  it('a non-blocking push fails open and sends as before', async () => {
    store.failSendingRead = true
    const res = await run({ ...action, blocking: false })
    expect(res.blockedError).toBeNull()
    expect(callExternalApi).toHaveBeenCalledTimes(1)
  })

  it('a blocking push marks its row so the stale-send alert ranks it as an order', async () => {
    await run()
    expect(JSON.parse(String(store.seenDuringCall[0].payload)).blocking).toBe(true)
    await run({ ...action, blocking: false })
    const last = store.seenDuringCall.at(-1) as Row
    expect(JSON.parse(String(last.payload)).blocking).toBeUndefined()
  })
})
