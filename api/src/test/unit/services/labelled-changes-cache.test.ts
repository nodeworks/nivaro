import { beforeEach, describe, expect, it, vi } from 'vitest'

const tables: Record<string, Array<Record<string, unknown>>> = {
  nivaro_fields: [
    { collection: 'workflows', field: 'amount', label: 'Amount' },
    { collection: 'workflows', field: 'vendor', label: 'Vendor' },
    { collection: 'workflows', field: 'notes', label: 'Notes' }
  ],
  nivaro_relations: [
    { many_collection: 'workflows', many_field: 'vendor', one_collection: 'vendors' }
  ]
}

function builder(table: string): unknown {
  const preds: Array<(r: Record<string, unknown>) => boolean> = []
  const target = {
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve((tables[table] ?? []).filter((r) => preds.every((p) => p(r)))).then(resolve)
  }
  const proxy: unknown = new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') return t.then
      return (...args: unknown[]) => {
        if (prop === 'where' && typeof args[0] === 'object') {
          const w = args[0] as Record<string, unknown>
          preds.push((r) => Object.entries(w).every(([k, v]) => r[k] === v))
        } else if (prop === 'whereIn') {
          const [c, vs] = args as [string, unknown[]]
          preds.push((r) => vs.includes(r[c]))
        }
        return proxy
      }
    }
  })
  return proxy
}

vi.mock('../../../db/index.js', () => ({ db: vi.fn((t: string) => builder(t)) }))
vi.mock('../../../services/mail.js', () => ({
  renderMailTemplate: vi.fn(),
  sendMail: vi.fn(),
  sendRawMail: vi.fn()
}))
vi.mock('../../../services/mail-record-card.js', () => ({}))
vi.mock('../../../services/queues.js', () => ({
  getLabels: vi.fn(async () => ({ 'vendors:5': 'ACME', 'vendors:6': 'Globex' }))
}))

import { db } from '../../../db/index.js'
import { type LabelMetaCache, labelledChanges } from '../../../services/mail-types.js'

beforeEach(() => vi.mocked(db).mockClear())

describe('labelledChanges meta cache', () => {
  it('reads a collection’s labels once and answers exactly as the uncached path', async () => {
    const delta = { amount: 10, vendor: 6 }
    const prev = { amount: 5, vendor: 5 }
    const plain = await labelledChanges('workflows', delta, prev, 40)
    expect(vi.mocked(db)).toHaveBeenCalledTimes(2)
    vi.mocked(db).mockClear()

    const cache: LabelMetaCache = new Map()
    const a = await labelledChanges('workflows', delta, prev, 40, cache)
    const b = await labelledChanges('workflows', { notes: 'x' }, null, 40, cache)
    expect(vi.mocked(db)).toHaveBeenCalledTimes(2)
    expect(a).toEqual(plain)
    expect(a.find((c) => c.field === 'vendor')).toMatchObject({ old: 'ACME', new: 'Globex' })
    expect(b).toEqual([{ field: 'notes', label: 'Notes', old: '', new: 'x' }])
  })
})
