import { describe, expect, it } from 'vitest'
import {
  ALL_COLLECTIONS,
  draftFromOpenWhen,
  incompleteOpenWhen,
  openWhenFromDraft
} from './open-when-draft'
import type { ConditionRule } from './types'

const PO = 'workflow_purchase_orders_junction:workflow'
const notPo: ConditionRule = { field: '$state', op: 'neq', value: 'waiting_on_po' }
const noPo: ConditionRule = { field: PO, op: 'related_none', value: null }

describe('open_when editor draft', () => {
  it('reads a per-collection map: no entry = owner, [] = anyone, rules = when', () => {
    const d = draftFromOpenWhen({ workflows: [notPo, noPo], nivaro_addendums: [] }, [
      'workflows',
      'nivaro_addendums',
      'inventory_request'
    ])
    expect(d.workflows).toEqual({ mode: 'when', rules: [notPo, noPo] })
    expect(d.nivaro_addendums).toEqual({ mode: 'anyone', rules: [] })
    expect(d.inventory_request).toEqual({ mode: 'owner', rules: [] })
  })

  it('a plain list applies to every collection', () => {
    const d = draftFromOpenWhen([notPo], ['workflows', 'nivaro_addendums'])
    expect(d.workflows.mode).toBe('when')
    expect(d.nivaro_addendums.rules).toEqual([notPo])
  })

  it('saves owner as no entry, anyone as [], and drops half-typed rules', () => {
    expect(
      openWhenFromDraft({
        workflows: { mode: 'when', rules: [notPo, { field: '', op: 'eq', value: '' }] },
        nivaro_addendums: { mode: 'anyone', rules: [] },
        inventory_request: { mode: 'owner', rules: [notPo] }
      })
    ).toEqual({ workflows: [notPo], nivaro_addendums: [] })
  })

  it('"When…" with no complete rule never saves as anyone (fail closed) and holds Save', () => {
    const d = {
      workflows: {
        mode: 'when' as const,
        rules: [{ field: '$state', op: 'eq' as const, value: '' }]
      }
    }
    expect(openWhenFromDraft(d)).toBeNull()
    expect(incompleteOpenWhen(d)).toEqual(['workflows'])
  })

  it('an unbound template keeps one plain list', () => {
    const d = draftFromOpenWhen(null, [])
    expect(Object.keys(d)).toEqual([ALL_COLLECTIONS])
    d[ALL_COLLECTIONS] = { mode: 'when', rules: [noPo] }
    expect(openWhenFromDraft(d)).toEqual([noPo])
  })

  it('keeps an entry for a collection the template no longer lists', () => {
    const d = draftFromOpenWhen({ old_table: [notPo] }, ['workflows'])
    expect(openWhenFromDraft(d)).toEqual({ old_table: [notPo] })
  })
})
