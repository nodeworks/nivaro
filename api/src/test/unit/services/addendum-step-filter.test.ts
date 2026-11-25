import { describe, expect, it, vi } from 'vitest'

// "Being amended" + a step: the ADDENDUM's own pipeline step, never the record's. On EFP every
// amended workflow is Completed, so the record-state filter answered nothing for "being amended,
// waiting on Level 1 approval" (Lindsey Pham, prod 2026-11-25).

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  return { db: knex({ client: 'mssql' }) }
})

import { db } from '../../../db/index.js'
import { addendumStateKeys, applyAddendumsFilter } from '../../../services/virtual-filters.js'

const sql = (value: unknown) => {
  const q = db('workflows').select('id')
  applyAddendumsFilter(q, 'workflows', value)
  return q.toString()
}

describe('applyAddendumsFilter with an addendum step', () => {
  it('in flight + the addendum instance sits in one of the steps', () => {
    const s = sql({ status: 'active', state: ['waiting_on_manager_approval'] })
    expect(s).toContain('[nivaro_addendums] as [adm]')
    expect(s).toContain("not in ('approved', 'rejected')")
    expect(s).toContain('[nivaro_workflow_instances] as [adwi]')
    expect(s).toContain("[adwi].[collection] = 'nivaro_addendums'")
    expect(s).toMatch(/\[adws\]\.\[key\] in \('waiting_on_manager_approval'\)/)
    // the record's own pipeline is not asked
    expect(s).not.toContain("[wfi].[collection]")
  })

  it('status any drops the in-flight test; the old shapes are unchanged', () => {
    expect(sql({ status: 'any', state: ['started'] })).not.toContain('not in')
    expect(sql('active')).not.toContain('adwi')
    expect(sql({ _eq: 'none' })).toContain('not exists')
  })

  it('an empty or unreadable step list, or "none" with steps, narrows to nothing', () => {
    expect(sql({ state: [] })).toContain('1 = 0')
    expect(sql({ state: 42 })).toContain('1 = 0')
    expect(sql({ status: 'none', state: ['started'] })).toContain('1 = 0')
  })

  it('reads step keys from a list, a comma list and operators', () => {
    expect(addendumStateKeys(['a', 'a', ' b '])).toEqual(['a', 'b'])
    expect(addendumStateKeys('a,b')).toEqual(['a', 'b'])
    expect(addendumStateKeys({ _in: ['x'] })).toEqual(['x'])
    expect(addendumStateKeys({ _eq: 'y' })).toEqual(['y'])
    expect(addendumStateKeys(null)).toEqual([])
  })
})
