import { beforeEach, describe, expect, it, vi } from 'vitest'

// A knex stand-in that honours where / whereIn / whereNull on the rows of
// tables[<table>] (column aliases like `c.` stripped); everything else chains.
const tables: Record<string, Array<Record<string, unknown>>> = {}

const norm = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v)

function builder(table: string): unknown {
  const preds: Array<(r: Record<string, unknown>) => boolean> = []
  const col = (c: unknown) => String(c).replace(/^\w+\./, '')
  const target = {
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve((tables[table] ?? []).filter((r) => preds.every((p) => p(r)))).then(
        resolve,
        reject
      )
  }
  const proxy: unknown = new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') return t.then
      return (...args: unknown[]) => {
        if (prop === 'where' && args.length === 2) {
          const [c, v] = args
          preds.push((r) => norm(r[col(c)]) === norm(v))
        } else if (prop === 'whereIn') {
          const [c, vs] = args as [string, unknown[]]
          const set = new Set(vs.map(norm))
          preds.push((r) => set.has(norm(r[col(c)])))
        } else if (prop === 'whereNull') {
          const [c] = args
          preds.push((r) => r[col(c)] == null)
        }
        return proxy
      }
    }
  })
  return proxy
}

vi.mock('../../../db/index.js', () => {
  const db = Object.assign(
    vi.fn((t: string) => builder(String(t).split(' ')[0])),
    { schema: { hasColumn: vi.fn(async () => true) }, raw: vi.fn(async () => []) }
  )
  return { db }
})
vi.mock('../../../services/mail-types.js', () => ({
  labelledChanges: vi.fn(async () => [{ field: 'x', label: 'X', old: '1', new: '2' }])
}))

import { resetChainColumnProbe } from '../../../services/chain-columns.js'
import { loadChainSteps } from '../../../services/event-path/exact.js'
import { labelledChanges } from '../../../services/mail-types.js'

const T = new Date('2026-09-24T10:00:05.000Z')
const CHAIN = '8b6213be-eae8-4cb2-b027-2f0ab216282b'

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  resetChainColumnProbe()
  vi.mocked(labelledChanges).mockClear()
})

describe('loadChainSteps — retried pushes', () => {
  it('shows attempts and retry calls that ran on other chains', async () => {
    tables.nivaro_erp_submissions = [
      {
        id: 3,
        chain_id: CHAIN,
        collection: 'workflows',
        item: '7',
        status: 'failed',
        attempts: 3,
        last_error: 'down',
        created_at: T,
        chain_parent: `request:${CHAIN}`,
        external_api: 4,
        api_name: 'MWF'
      }
    ]
    tables.nivaro_erp_submission_attempts = [
      {
        id: 1,
        submission_id: 3,
        attempt: 2,
        status: 'failed',
        http_status: 500,
        error: 'boom',
        recorded_at: T,
        chain_id: 'aaaaaaaa-0000-4000-8000-000000000001',
        chain_parent: 'cron:erp-retry'
      },
      {
        id: 2,
        submission_id: 3,
        attempt: 3,
        status: 'rejected',
        http_status: 422,
        error: 'no',
        recorded_at: T,
        chain_id: 'aaaaaaaa-0000-4000-8000-000000000002',
        chain_parent: 'cron:erp-retry'
      }
    ]
    tables.nivaro_external_api_logs = [
      // The retry's call, made while the push was open: shown.
      {
        id: 9,
        api_id: 4,
        method: 'POST',
        url: 'https://mwf.example/x',
        response_status: 500,
        created_at: T,
        chain_id: 'AAAAAAAA-0000-4000-8000-000000000001',
        chain_parent: 'submission:3',
        api_name: 'MWF'
      },
      // Same retry chain, but not under this push: not shown.
      {
        id: 10,
        api_id: 4,
        method: 'GET',
        url: 'https://mwf.example/y',
        response_status: 200,
        created_at: T,
        chain_id: 'aaaaaaaa-0000-4000-8000-000000000001',
        chain_parent: 'cron:erp-retry',
        api_name: 'MWF'
      },
      // Names the push but on an unrelated chain: not shown.
      {
        id: 11,
        api_id: 4,
        method: 'POST',
        url: 'https://mwf.example/z',
        response_status: 200,
        created_at: T,
        chain_id: 'bbbbbbbb-0000-4000-8000-000000000009',
        chain_parent: 'submission:3',
        api_name: 'MWF'
      }
    ]
    const { steps } = await loadChainSteps(CHAIN.toUpperCase(), { withBodies: false })
    const byKey = new Map(steps.map((s) => [s.key, s]))
    expect(byKey.get('submission:3')?.parent).toBe(`request:${CHAIN}`)
    expect(byKey.get('attempt:1')).toMatchObject({ parent: 'submission:3', failed: true })
    expect(byKey.get('attempt:2')).toMatchObject({ parent: 'submission:3', failed: true })
    expect(byKey.get('call:9')?.parent).toBe('submission:3')
    expect(byKey.has('call:10')).toBe(false)
    expect(byKey.has('call:11')).toBe(false)
  })
})

describe('loadChainSteps — root key and write labels', () => {
  const act = (id: number, parent: string, collection = 'workflow_line_items') => ({
    id,
    action: 'update',
    collection,
    item: String(id),
    timestamp: T,
    chain_id: CHAIN,
    chain_parent: parent,
    revision_id: id,
    delta: '{"x":2}'
  })

  it('keys the request root lower-case whatever case the chain id arrives in', async () => {
    tables.nivaro_api_logs = [
      {
        id: 1,
        chain_id: CHAIN,
        chain_parent: null,
        method: 'POST',
        path: '/graphql',
        status: 200,
        created_at: T,
        latency_ms: 10
      }
    ]
    tables.nivaro_activity = [act(1, `request:${CHAIN.toUpperCase()}`)]
    const { rootStep, steps } = await loadChainSteps(CHAIN.toUpperCase(), { withBodies: true })
    expect(rootStep?.key).toBe(`request:${CHAIN}`)
    expect(steps.find((s) => s.key === 'activity:1')?.parent).toBe(rootStep?.key)
  })

  it('skips change labels for writes that fold, and shares one label cache', async () => {
    const bulk = Array.from({ length: 30 }, (_, i) => act(100 + i, 'import_run:4'))
    const few = [1, 2, 3].map((i) => act(i, 'history:9', 'workflows'))
    tables.nivaro_activity = [...bulk, ...few]
    const { steps } = await loadChainSteps(CHAIN, { withBodies: true })
    const calls = vi.mocked(labelledChanges).mock.calls
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c[0] === 'workflows')).toBe(true)
    // One cache object for the whole path.
    expect(new Set(calls.map((c) => c[4])).size).toBe(1)
    expect(steps.find((s) => s.key === 'activity:1')?.summary).toBe('updated X')
    expect(steps.find((s) => s.key === 'activity:100')?.summary).toBe('updated')
    expect(steps.find((s) => s.key === 'activity:100')?.detail).toBeNull()
  })
})
