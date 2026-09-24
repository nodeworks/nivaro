import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'
import { db } from '../../../db/index.js'
import {
  clearObligationKinds,
  flowHaltReason,
  registerObligationKind
} from '../../../services/integration-obligations.js'
import { callExternalApi } from '../../../services/external-apis.js'
import { executeFlow, type ExecutionContext } from '../../../services/flow-executor.js'

vi.mock('../../../services/external-apis.js', () => ({
  callExternalApi: vi.fn()
}))

describe('flowHaltReason', () => {
  it('names the op that halted the chain', () => {
    expect(flowHaltReason('Check PO linked')).toBe('flow condition rejected at "Check PO linked"')
  })

  it('is null when the flow ran to the end — nothing to explain', () => {
    expect(flowHaltReason(null)).toBeNull()
  })

  it('is null for an empty halt marker rather than an empty quote', () => {
    expect(flowHaltReason('')).toBeNull()
  })
})

// ─── The obligation-open/resolve wiring inside executeFlow ────────────────────
// A minimal but real FlowOperation shape (not exported by flow-executor.ts, so
// mirrored structurally here) and a hand-rolled db(table) dispatcher — the
// global mock from src/test/setup.ts answers every table identically, but a
// real flow run touches nivaro_flows, nivaro_flow_operations, nivaro_flow_runs
// AND nivaro_integration_obligations in one pass, each needing its own shape.

interface FlowOpFixture {
  id: string
  flow: string
  name: string
  key: string
  type: string
  position_x: number
  position_y: number
  options: string | null
  resolve: string | null
  reject: string | null
}

function fakeLog(): FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  } as unknown as FastifyBaseLogger
}

/** A thenable that also carries the chain methods a query builder needs
 *  before the final await — `.where().orderBy().orderBy()` all resolve to
 *  the same fixture regardless of how many chain calls precede the await. */
function thenableRows<T>(rows: T[]) {
  const chain: Record<string, unknown> = {}
  chain.where = vi.fn(() => chain)
  chain.orderBy = vi.fn(() => chain)
  chain.then = (resolve: (v: T[]) => void) => resolve(rows)
  return chain
}

function flowRunsChain() {
  const chain: Record<string, unknown> = {}
  chain.insert = vi.fn().mockResolvedValue(undefined)
  chain.where = vi.fn(() => chain)
  chain.update = vi.fn().mockResolvedValue(1)
  return chain
}

/** A generic default chain for tables this suite doesn't care about
 *  (nivaro_flows' shadow-mode/concurrency lookup) — mirrors setup.ts's own
 *  default shape closely enough for `.first()` to resolve to null. */
function defaultChain() {
  const chain: Record<string, unknown> = {
    select: vi.fn().mockResolvedValue([]),
    insert: vi.fn().mockResolvedValue([1]),
    update: vi.fn().mockResolvedValue(1),
    first: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue([{ total: 0 }])
  }
  for (const m of ['where', 'orderBy', 'limit', 'offset']) {
    chain[m] = vi.fn().mockReturnValue(chain)
  }
  return chain
}

/** Wires db(table) for one flow run: the ops fixture answers
 *  nivaro_flow_operations, obligation inserts always land at
 *  `obligationRowId`, and every update to nivaro_integration_obligations is
 *  captured so a test can assert on the outcome/reason it resolved with. */
function wireDb(ops: FlowOpFixture[], obligationRowId: number) {
  const resolvedUpdates: Array<Record<string, unknown>> = []
  openedRows.length = 0
  vi.mocked(db as unknown as (table: string) => unknown).mockImplementation(
    (table: string): unknown => {
      if (table === 'nivaro_flow_operations') return thenableRows(ops)
      if (table === 'nivaro_flow_runs') return flowRunsChain()
      if (table === 'nivaro_integration_obligations') {
        const chain: Record<string, unknown> = {}
        chain.insert = vi.fn((row: Record<string, unknown>) => {
          openedRows.push(row)
          return { returning: vi.fn().mockResolvedValue([{ id: obligationRowId }]) }
        })
        chain.where = vi.fn(() => ({
          update: vi.fn((row: Record<string, unknown>) => {
            resolvedUpdates.push(row)
            return Promise.resolve(1)
          })
        }))
        return chain
      }
      return defaultChain()
    }
  )
  return resolvedUpdates
}

/** Every obligation row a run inserted — the ledger's "the partner was owed this". */
const openedRows: Array<Record<string, unknown>> = []

const PARTNER_KIND = { api: 'Partner', collection: 'workflows', label: 'x', expect: async () => [] }

function baseCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    flowId: 'flow-1',
    flowName: 'Test Flow',
    trigger: 'test',
    payload: { collection: 'workflows', item: '123' },
    log: fakeLog(),
    ...overrides
  }
}

describe('executeFlow — obligation ledger for a flow that pushes to a partner', () => {
  afterEach(() => {
    clearObligationKinds()
    vi.mocked(db as unknown as (table: string) => unknown).mockReset()
    vi.mocked(callExternalApi).mockReset()
  })

  it('a condition rejecting BEFORE the push opens no obligation — the flow decided it does not apply to this record', async () => {
    registerObligationKind({ ...PARTNER_KIND, kind: 'wf.push' })
    const ops: FlowOpFixture[] = [
      {
        id: 'op-gate',
        flow: 'flow-1',
        name: 'Gate',
        key: 'gate',
        type: 'condition',
        position_x: 0,
        position_y: 0,
        options: JSON.stringify({ field: 'nope', operator: 'eq', value: 'yes' }),
        resolve: 'op-push',
        reject: null
      },
      {
        id: 'op-push',
        flow: 'flow-1',
        name: 'Push',
        key: 'push',
        type: 'external-api',
        position_x: 0,
        position_y: 1,
        options: JSON.stringify({ mode: 'predefined', api_id: 'Partner' }),
        resolve: null,
        reject: null
      }
    ]
    const resolvedUpdates = wireDb(ops, 501)

    await executeFlow(baseCtx())

    // The condition halted the chain before op-push ever ran: nothing was
    // owed, so nothing is opened and nothing is resolved.
    expect(callExternalApi).not.toHaveBeenCalled()
    expect(openedRows).toHaveLength(0)
    expect(resolvedUpdates).toHaveLength(0)
  })

  it('a condition rejecting AFTER the push resolves the (opened) obligation skipped, naming the op', async () => {
    registerObligationKind({ ...PARTNER_KIND, kind: 'wf.push' })
    vi.mocked(callExternalApi).mockResolvedValue({
      status: 200,
      body: { ok: true },
      ok: true
    } as never)
    const ops: FlowOpFixture[] = [
      {
        id: 'op-push',
        flow: 'flow-1',
        name: 'Push',
        key: 'push',
        type: 'external-api',
        position_x: 0,
        position_y: 0,
        options: JSON.stringify({ mode: 'predefined', api_id: 'Partner' }),
        resolve: 'op-check',
        reject: null
      },
      {
        id: 'op-check',
        flow: 'flow-1',
        name: 'Check',
        key: 'check',
        type: 'condition',
        position_x: 0,
        position_y: 1,
        options: JSON.stringify({ field: 'nope', operator: 'eq', value: 'yes' }),
        resolve: null,
        reject: null
      }
    ]
    const resolvedUpdates = wireDb(ops, 501)

    await executeFlow(baseCtx())

    expect(callExternalApi).toHaveBeenCalledTimes(1)
    expect(openedRows).toHaveLength(1)
    expect(resolvedUpdates).toHaveLength(1)
    expect(resolvedUpdates[0].outcome).toBe('skipped')
    expect(resolvedUpdates[0].reason).toBe('flow condition rejected at "check"')
  })

  it('an external-api op that 4xxs with no reject branch wired resolves failed with the HTTP status — not a mislabelled skip', async () => {
    registerObligationKind({ ...PARTNER_KIND, kind: 'wf.push' })
    const ops: FlowOpFixture[] = [
      {
        id: 'op-push',
        flow: 'flow-1',
        name: 'Push',
        key: 'push',
        type: 'external-api',
        position_x: 0,
        position_y: 0,
        options: JSON.stringify({ mode: 'predefined', api_id: 'Partner' }),
        resolve: null,
        reject: null
      }
    ]
    const resolvedUpdates = wireDb(ops, 502)
    vi.mocked(callExternalApi).mockResolvedValue({
      status: 422,
      headers: {},
      body: { error: 'nope' }
    })

    await executeFlow(baseCtx())

    // Before the fix this landed 'skipped: flow condition rejected at "push"'
    // — progress.halted is set for the dead-end reject regardless of op
    // type. The op that halted was the push itself, not a condition.
    expect(resolvedUpdates).toHaveLength(1)
    expect(resolvedUpdates[0].outcome).toBe('failed')
    expect(resolvedUpdates[0].reason).toBe('HTTP 422')
  })

  it('a network exception (callExternalApi throws) resolves failed with the $error text', async () => {
    registerObligationKind({ ...PARTNER_KIND, kind: 'wf.push' })
    const ops: FlowOpFixture[] = [
      {
        id: 'op-push',
        flow: 'flow-1',
        name: 'Push',
        key: 'push',
        type: 'external-api',
        position_x: 0,
        position_y: 0,
        options: JSON.stringify({ mode: 'predefined', api_id: 'Partner' }),
        resolve: null,
        reject: null
      }
    ]
    const resolvedUpdates = wireDb(ops, 503)
    vi.mocked(callExternalApi).mockRejectedValue(new Error('ECONNREFUSED'))

    await executeFlow(baseCtx())

    // No __http_status at all on this path (the fetch/callExternalApi threw
    // before a status existed) — falls back to the op's own $error text
    // rather than the generic "flow ran but no operation acted".
    expect(resolvedUpdates).toHaveLength(1)
    expect(resolvedUpdates[0].outcome).toBe('failed')
    expect(resolvedUpdates[0].reason).toBe('external API request failed')
  })

  it('a landed 2xx push resolves pending, never skipped or failed', async () => {
    registerObligationKind({ ...PARTNER_KIND, kind: 'wf.push' })
    const ops: FlowOpFixture[] = [
      {
        id: 'op-push',
        flow: 'flow-1',
        name: 'Push',
        key: 'push',
        type: 'external-api',
        position_x: 0,
        position_y: 0,
        options: JSON.stringify({ mode: 'predefined', api_id: 'Partner' }),
        resolve: null,
        reject: null
      }
    ]
    const resolvedUpdates = wireDb(ops, 504)
    vi.mocked(callExternalApi).mockResolvedValue({ status: 200, headers: {}, body: { ok: true } })

    await executeFlow(baseCtx())

    expect(resolvedUpdates).toHaveLength(1)
    expect(resolvedUpdates[0].outcome).toBe('pending')
    expect(resolvedUpdates[0].reason).toBeNull()
  })

  it('a dry run opens no obligation and resolves nothing — the partner was never actually called', async () => {
    registerObligationKind({ ...PARTNER_KIND, kind: 'wf.push' })
    const ops: FlowOpFixture[] = [
      {
        id: 'op-push',
        flow: 'flow-1',
        name: 'Push',
        key: 'push',
        type: 'external-api',
        position_x: 0,
        position_y: 0,
        options: JSON.stringify({ mode: 'predefined', api_id: 'Partner' }),
        resolve: null,
        reject: null
      }
    ]
    const resolvedUpdates = wireDb(ops, 505)

    await executeFlow(baseCtx({ dryRun: true }))

    expect(callExternalApi).not.toHaveBeenCalled()
    expect(resolvedUpdates).toHaveLength(0)
  })

  it('no registered kind for the api means no obligation opens — an unregistered integration stays silent', async () => {
    // Deliberately no registerObligationKind call.
    const ops: FlowOpFixture[] = [
      {
        id: 'op-push',
        flow: 'flow-1',
        name: 'Push',
        key: 'push',
        type: 'external-api',
        position_x: 0,
        position_y: 0,
        options: JSON.stringify({ mode: 'predefined', api_id: 'Partner' }),
        resolve: null,
        reject: null
      }
    ]
    const resolvedUpdates = wireDb(ops, 506)
    vi.mocked(callExternalApi).mockResolvedValue({ status: 500, headers: {}, body: {} })

    await executeFlow(baseCtx())

    expect(resolvedUpdates).toHaveLength(0)
  })
})
