import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { editedRowIds, invalidateM2MFor } from './m2m-invalidate'
import { recordLookupsFor, rememberRecordLookups, resetRecordLookups } from './record-lookups'

function watch(qc: QueryClient, parentId: string | number) {
  const queryFn = vi.fn(async () => [{ id: `${parentId}-j` }])
  const observer = new QueryObserver(qc, {
    queryKey: ['m2m-items', 'workflows_regions', 'workflows_id', parentId],
    queryFn,
    staleTime: 60_000
  })
  const unsubscribe = observer.subscribe(() => {})
  return { queryFn, unsubscribe }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('invalidateM2MFor', () => {
  it('refetches only the saved record and its edited rows; marks the rest stale', async () => {
    const qc = new QueryClient()
    const record = watch(qc, 372683)
    const editedRow = watch(qc, 'row-7')
    const otherRow = watch(qc, 'row-8')
    await settle()
    for (const w of [record, editedRow, otherRow]) expect(w.queryFn).toHaveBeenCalledTimes(1)

    invalidateM2MFor(qc, ['372683', 'row-7'])
    await settle()

    expect(record.queryFn).toHaveBeenCalledTimes(2)
    expect(editedRow.queryFn).toHaveBeenCalledTimes(2)
    expect(otherRow.queryFn).toHaveBeenCalledTimes(1)
    const other = qc.getQueryState(['m2m-items', 'workflows_regions', 'workflows_id', 'row-8'])
    expect(other?.isInvalidated).toBe(true)
    for (const w of [record, editedRow, otherRow]) w.unsubscribe()
    qc.clear()
  })

  it('lists the row ids of pending grid edits', () => {
    const edits = new Map<string, Map<string, Record<string, unknown>>>([
      ['workflow_lines.workflow', new Map([['11', { qty: 2 }]])],
      ['workflow_notes.workflow', new Map([['12', { body: 'x' }]])]
    ])
    expect(editedRowIds(edits)).toEqual(['11', '12'])
  })
})

describe('record lookups', () => {
  afterEach(() => resetRecordLookups())
  it('remembers what a collection needed; nothing needed = no prefetch', () => {
    expect(recordLookupsFor('workflows')).toBeNull()
    rememberRecordLookups('workflows', { role: true, state: false })
    expect(recordLookupsFor('workflows')).toEqual({ role: true, state: false })
    rememberRecordLookups('workflows', { role: false, state: false })
    expect(recordLookupsFor('workflows')).toBeNull()
  })
})
