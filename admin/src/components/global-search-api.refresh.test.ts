import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { refreshAfterCommand } from './global-search-api'
import { commandTarget, type SearchCommand } from './global-search-helpers'

const cmd = (over: Partial<SearchCommand> = {}): SearchCommand => ({
  id: 'c1',
  label: 'Approve',
  kind: 'transition',
  confirm: 'Approve?',
  payload: { transition_id: 't1' },
  ...over
})

describe('A2 — a search command refreshes the screens that show its record', () => {
  it('reads the target from the command or its payload', () => {
    expect(commandTarget(cmd({ collection: 'workflows', item: '7' }))).toEqual({
      collection: 'workflows',
      item: '7'
    })
    expect(
      commandTarget(cmd({ payload: { body: { collection: 'invoices', ids: [] }, id: 42 } }))
    ).toEqual({ collection: 'invoices', item: '42' })
  })

  it('marks the list rows and that record stale, not a key nothing reads', () => {
    const qc = new QueryClient()
    const keys = [
      ['cbv-items', 'workflows', { page: 1 }],
      ['cbv-pipeline-instances', 'workflows', ['7']],
      ['item', 'workflows', '7'],
      ['item', 'workflows', '8'],
      ['cbv-items', 'invoices', { page: 1 }],
      ['global-search', 'x']
    ]
    for (const k of keys) qc.setQueryData(k, { ok: true })
    refreshAfterCommand(qc, cmd({ collection: 'workflows', item: '7' }))
    const stale = (k: unknown[]) => qc.getQueryState(k)?.isInvalidated
    expect(stale(keys[0])).toBe(true)
    expect(stale(keys[1])).toBe(true)
    expect(stale(keys[2])).toBe(true)
    expect(stale(keys[3])).toBe(false)
    expect(stale(keys[4])).toBe(false)
    expect(stale(keys[5])).toBe(true)
  })
})
