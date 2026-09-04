import { describe, expect, it } from 'vitest'

import { resolveSweepItems } from '../../../services/flow-sweep-items.js'

const getByPath = (obj: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (cur, k) => (cur && typeof cur === 'object' ? (cur as any)[k] : undefined),
      obj
    )
const render = (t: string, data: Record<string, unknown>) =>
  t.replace(/\{\{([^}]+)\}\}/g, (_, p: string) => {
    const v = getByPath(data, p.trim())
    return v === undefined || v === null ? '' : String(v)
  })

describe('resolveSweepItems', () => {
  it('returns undefined when the option is absent or blank (= full scan)', () => {
    expect(resolveSweepItems(undefined, {}, render, getByPath)).toBeUndefined()
    expect(resolveSweepItems(null, {}, render, getByPath)).toBeUndefined()
    expect(resolveSweepItems('   ', {}, render, getByPath)).toBeUndefined()
  })

  it('resolves a bare {{path}} template to the flow-data array', () => {
    const data = { po_linked: { workflow_ids: ['371393', 371394, '371393'] } }
    expect(resolveSweepItems('{{po_linked.workflow_ids}}', data, render, getByPath)).toEqual([
      '371393',
      '371394'
    ])
  })

  it('a configured template that resolves to nothing yields [] — never undefined', () => {
    expect(resolveSweepItems('{{po_linked.workflow_ids}}', {}, render, getByPath)).toEqual([])
    expect(
      resolveSweepItems(
        '{{po_linked.workflow_ids}}',
        { po_linked: { workflow_ids: [] } },
        render,
        getByPath
      )
    ).toEqual([])
  })

  it('accepts literal arrays, comma lists and rendered mixed templates', () => {
    expect(resolveSweepItems([1, ' 2 ', null, { id: 3 }], {}, render, getByPath)).toEqual([
      '1',
      '2',
      '3'
    ])
    expect(resolveSweepItems('10, 11,,12', {}, render, getByPath)).toEqual(['10', '11', '12'])
    expect(resolveSweepItems('{{a}},{{b}}', { a: 5, b: '' }, render, getByPath)).toEqual(['5'])
  })
})
