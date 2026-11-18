import type { FastifyBaseLogger } from 'fastify'
import { describe, expect, it, vi } from 'vitest'

// item-read in filter mode with no matching row: by default a failed step
// (the run lands 'error'); with `no_match: 'stop'` it ends the chain quietly
// like a condition that did not match (MWF push-PO flow on workflows that never
// came from MWF — 61 false "errors" in a week on prod, 2026-11-18).

const first = vi.fn(async () => undefined)
const chain = { where: () => chain, orderBy: () => chain, first }
vi.mock('../../../db/index.js', () => ({ db: () => chain }))

const { runItemRead } = await import('../../../services/flow-executor.js')

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
} as unknown as FastifyBaseLogger
const ctx = { flowId: 'F1', flowName: 'F', trigger: 'test', payload: {}, log } as never
const op = (options: Record<string, unknown>) =>
  ({
    id: 'o1',
    flow: 'F1',
    name: 'Read MWF',
    key: 'read_mwf',
    type: 'item-read',
    position_x: 0,
    position_y: 0,
    options: JSON.stringify(options),
    resolve: null,
    reject: null
  }) as never

const base = {
  collection: 'mwf_queue',
  id: '',
  filter: { workflow: '{{payload.workflow}}' },
  result_key: 'mwf'
}
const data = { payload: { workflow: 373019 } } as never

describe('item-read no match', () => {
  it('is a failed step by default', async () => {
    const r = await runItemRead(op(base), data, ctx)
    expect(r.status).toBe('reject')
    expect((r.output as Record<string, unknown>).$error).toBe('item-read: no match')
  })

  it("ends quietly with no_match: 'stop' — no $error, marked with the op key", async () => {
    const r = await runItemRead(op({ ...base, no_match: 'stop' }), data, ctx)
    expect(r.status).toBe('reject')
    expect((r.output as Record<string, unknown>).$error).toBeUndefined()
    expect((r.output as Record<string, unknown>).$no_match).toBe('read_mwf')
  })
})
