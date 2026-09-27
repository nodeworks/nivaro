import { beforeEach, describe, expect, it, vi } from 'vitest'

const updateOne = vi.fn(async () => ({}))
const createOne = vi.fn(async () => ({ id: 77 }))
const deleteOne = vi.fn(async () => undefined)
const recalc = vi.fn(async () => ({ fields: ['po_amount'], records: 1 }))
const runLongSql = vi.fn(async () => [])

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/items.js', () => ({ updateOne, createOne, deleteOne }))
vi.mock('../../../services/rollups.js', () => ({ recalcStoredRollupsForRecords: recalc }))
vi.mock('../../../services/run-long.js', () => ({ runLongSql }))

const {
  buildImportTools,
  getImportProcessor,
  isProcessorKey,
  listImportProcessors,
  registerImportProcessor
} = await import('../../../services/import-processors.js')

const user = { id: 'u1', role: 'r1' } as never

beforeEach(() => {
  vi.clearAllMocks()
})

describe('import processor registry', () => {
  it('accepts <extension>:<name> keys and finds them whatever their case', () => {
    registerImportProcessor({ key: 'acme:orders', label: 'Orders', run: async () => ({}) as never })
    expect(getImportProcessor('ACME:Orders')?.label).toBe('Orders')
    expect(listImportProcessors().some((p) => p.key === 'acme:orders')).toBe(true)
  })

  it('refuses keys that could be mistaken for a built-in mode', () => {
    for (const key of ['service', 'proc', 'orders', 'acme:', ':orders', 'acme orders:x']) {
      expect(() =>
        registerImportProcessor({ key, label: 'x', run: async () => ({}) as never })
      ).toThrow()
      expect(isProcessorKey(key)).toBe(false)
    }
  })

  it('answers null for a key nothing registered', () => {
    expect(getImportProcessor('nobody:here')).toBeNull()
    expect(getImportProcessor(null)).toBeNull()
  })
})

describe('import tools', () => {
  it('stamps the run on every write and never recalculates rollups per created row', async () => {
    const tools = buildImportTools({ user, stamp: 'import:Orders:run-9', dryRun: false })
    await tools.update('orders', 5, { amount: 1 })
    expect(updateOne).toHaveBeenCalledWith(user, 'orders', 5, {
      amount: 1,
      _change_reason: 'import:Orders:run-9'
    })
    expect(await tools.create('orders', { amount: 2 })).toBe(77)
    expect(createOne).toHaveBeenCalledWith(
      user,
      'orders',
      { amount: 2, _change_reason: 'import:Orders:run-9' },
      undefined,
      undefined,
      { skipRollupRecalc: true }
    )
  })

  it('refuses system collections and unsafe names', async () => {
    const tools = buildImportTools({ user, stamp: null, dryRun: false })
    await expect(tools.update('nivaro_users', 1, {})).rejects.toThrow(/may not write/)
    await expect(tools.create('orders; drop', {})).rejects.toThrow(/may not write/)
    await expect(tools.runProcedure('x; DROP TABLE y')).rejects.toThrow(/Unsafe procedure/)
    expect(runLongSql).not.toHaveBeenCalled()
  })

  it('refuses every write on a dry run', async () => {
    const tools = buildImportTools({ user, stamp: null, dryRun: true })
    await expect(tools.update('orders', 1, {})).rejects.toThrow(/dry run/)
    await expect(tools.create('orders', {})).rejects.toThrow(/dry run/)
    await expect(tools.remove('orders', 1)).rejects.toThrow(/dry run/)
    await expect(tools.runProcedure('tail')).rejects.toThrow(/dry run/)
    await expect(tools.runWrites([{ label: 'x', run: async () => {} }])).rejects.toThrow(/dry run/)
    expect(updateOne).not.toHaveBeenCalled()
  })

  it('runs writes several at a time and lets a failure stand alone', async () => {
    const tools = buildImportTools({ user, stamp: null, dryRun: false })
    let live = 0
    let peak = 0
    const jobs = Array.from({ length: 40 }, (_, i) => ({
      label: `row ${i}`,
      run: async () => {
        live++
        peak = Math.max(peak, live)
        await new Promise((r) => setTimeout(r, 5))
        live--
        if (i === 7) throw new Error('nope')
      }
    }))
    const out = await tools.runWrites(jobs, { width: 8 })
    expect(out.done).toBe(39)
    expect(out.failed).toBe(1)
    expect(out.failures).toEqual(['row 7: nope'])
    expect(peak).toBe(8)
  })

  it('recalculates stored rollups once per record, however often it is named', async () => {
    const tools = buildImportTools({ user, stamp: null, dryRun: false })
    expect(await tools.recalcStoredRollups('workflows', [1, 2, 2, '1', 3])).toBe(3)
    expect(recalc).toHaveBeenCalledTimes(3)
  })
})
