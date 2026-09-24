import { beforeEach, describe, expect, it, vi } from 'vitest'

// Table-aware knex stand-in: db('<table> as x') yields tables[<table>];
// .first() yields its first row.
const tables: Record<string, unknown[]> = {}

function builder(table: string): unknown {
  let first = false
  const target = {
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const rows = tables[table] ?? []
      return Promise.resolve(first ? rows[0] : rows).then(resolve, reject)
    }
  }
  const proxy: unknown = new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') return t.then
      if (prop === 'catch') return () => proxy
      return (...args: unknown[]) => {
        if (prop === 'first') first = true
        for (const a of args) if (typeof a === 'function') (a as (b: unknown) => void)(proxy)
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
vi.mock('../../../services/mail-types.js', () => ({ labelledChanges: vi.fn(async () => []) }))
vi.mock('../../../services/submission-detail.js', async (orig) => ({
  ...(await orig<typeof import('../../../services/submission-detail.js')>()),
  gatherSubmissionFacts: vi.fn()
}))

import { resetChainColumnProbe } from '../../../services/chain-columns.js'
import { loadChainSteps } from '../../../services/event-path/exact.js'
import { inferSteps } from '../../../services/event-path/inferred.js'
import type { EventEntry } from '../../../services/integration-event-sources.js'
import { gatherSubmissionFacts } from '../../../services/submission-detail.js'

const T = new Date('2026-09-24T10:00:05.000Z')
const call = {
  id: 9,
  api_id: 4,
  method: 'GET',
  url: 'https://partner.example/v1/orders?api_key=SEKRET123&page=2',
  response_status: 401,
  duration_ms: 120,
  error: 'HTTP 401: {"error":"denied","access_token":"TOK-1"}\nfull partner reply body',
  created_at: T,
  chain_parent: 'submission:3',
  api_name: 'LinX'
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  resetChainColumnProbe()
})

describe('loadChainSteps redaction', () => {
  it('non-admin: call URL without query, error reduced to a masked first line', async () => {
    tables.nivaro_external_api_logs = [call]
    tables.nivaro_erp_submissions = [
      {
        id: 3,
        collection: 'workflows',
        item: '7',
        status: 'failed',
        attempts: 2,
        last_error: 'rejected: {"client_secret":"CS-1"}\nsecond line',
        created_at: T,
        chain_parent: null,
        external_api: 4,
        api_name: 'LinX'
      }
    ]
    tables.nivaro_erp_submission_attempts = [
      {
        id: 1,
        submission_id: 3,
        attempt: 1,
        status: 'failed',
        http_status: 500,
        error: 'boom\nstack',
        recorded_at: T,
        chain_parent: null
      }
    ]
    const { steps } = await loadChainSteps('c1', { withBodies: false })
    const c = steps.find((s) => s.key === 'call:9')
    expect(c?.detail).toMatchObject({ type: 'call', url: 'https://partner.example/v1/orders' })
    const text = JSON.stringify(steps)
    for (const leak of [
      'SEKRET123',
      'TOK-1',
      'CS-1',
      'full partner reply',
      'second line',
      'stack'
    ]) {
      expect(text).not.toContain(leak)
    }
    expect(steps.find((s) => s.key === 'attempt:1')?.reason).toBe('boom')
  })

  it('admin: query kept but the api key masked; full error text', async () => {
    tables.nivaro_external_api_logs = [call]
    const { steps } = await loadChainSteps('c1', { withBodies: true })
    const d = steps.find((s) => s.key === 'call:9')?.detail as { url: string; error: string }
    expect(d.url).not.toContain('SEKRET123')
    expect(d.url).toContain('page=2')
    expect(d.error).toContain('full partner reply body')
  })
})

describe('inferSteps', () => {
  const inbound: EventEntry = {
    id: '55',
    source: 'core:inbound',
    direction: 'in',
    label: 'LinX',
    text: 'POST /graphql · 200',
    created_at: T.toISOString(),
    collection: null,
    item_id: null
  }

  it('inbound: includes transitions on records the inferred writes touched', async () => {
    tables.nivaro_api_logs = [{ user: 'U1', created_at: T, latency_ms: 800 }]
    tables.nivaro_activity = [
      {
        id: 1,
        action: 'update',
        collection: 'workflows',
        item: '7',
        timestamp: new Date(T.getTime() - 300)
      }
    ]
    tables.nivaro_workflow_history = [
      {
        id: 5,
        timestamp: new Date(T.getTime() - 200),
        collection: 'workflows',
        item: '7',
        from_label: 'Started',
        to_label: 'Manager',
        transition_label: 'Submit',
        comment: null
      },
      {
        id: 6,
        timestamp: new Date(T.getTime() - 100),
        collection: 'workflows',
        item: '8',
        from_label: 'A',
        to_label: 'B',
        transition_label: 'X',
        comment: null
      }
    ]
    const { steps } = await inferSteps(inbound)
    const h = steps.find((s) => s.key === 'history:5')
    expect(h).toMatchObject({ kind: 'transition', inferred: true, summary: 'Submit → Manager' })
    expect(h?.reason).toMatch(/transition on a record this call wrote/)
    expect(steps.find((s) => s.key === 'history:6')).toBeUndefined()
  })

  it('outbound: includes the push’s matched call logs, inferred and redacted', async () => {
    vi.mocked(gatherSubmissionFacts).mockResolvedValue({
      row: { collection: 'workflows', item: '7', external_api: 4 },
      api: { id: 4, name: 'LinX', owner_user: null },
      history: null,
      record_edit: null,
      call_logs: [{ ...call, body_match: false, triggered_by: 'transition-action', user_id: null }]
    } as never)
    const ev: EventEntry = {
      id: '3',
      source: 'core:outbound',
      direction: 'out',
      label: 'LinX',
      text: 'push · failed',
      created_at: T.toISOString(),
      collection: 'workflows',
      item_id: '7'
    }
    const { rootStep, steps } = await inferSteps(ev, { withBodies: false })
    const c = steps.find((s) => s.key === 'call:9')
    expect(c).toMatchObject({
      kind: 'partner_call',
      parent: rootStep.key,
      inferred: true,
      api_id: 4,
      failed: true
    })
    expect(c?.reason).toMatch(/within 10 s of an attempt/)
    expect(JSON.stringify(c)).not.toContain('SEKRET123')
    expect(JSON.stringify(c)).not.toContain('full partner reply')
  })
})
