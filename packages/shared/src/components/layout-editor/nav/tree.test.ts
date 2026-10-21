import { describe, expect, it } from 'vitest'
import {
  HEADER_GROUP_KEY,
  type LayoutBundle,
  newGroup,
  newPlacement,
  ungroupedGroup
} from '../../../lib/layout-ops'
import { findHits, textMatcher } from './find'
import { buildOutline, crumbsOf, type NavNode, pathOf } from './tree'

function bundle(): LayoutBundle {
  return {
    layout: { id: 1, collection: 'orders', name: 'Order', layout_type: 'grouped' },
    groups: [
      { ...newGroup('main', 'Main', 'section', null), sort: 0 },
      ungroupedGroup(1),
      { ...newGroup('flow', 'Flow', 'container', null), sort: 2, tab_mode: 'steps' },
      { ...newGroup('one', 'Request', 'tab', 'flow'), sort: 0 },
      { ...newGroup('two', 'Billing', 'tab', 'flow'), sort: 1 }
    ],
    placements: [
      { ...newPlacement('title', 'main'), sort: 0 },
      { ...newPlacement('amount', 'main'), sort: 1, overrides: { hidden: true } },
      { ...newPlacement('loose', null), sort: 0 },
      { ...newPlacement('vendor', 'one'), sort: 0 },
      { ...newPlacement('total_cost', 'two'), sort: 0, label_override: 'Grand total' },
      { ...newPlacement('__comments__', null), sort: 3 },
      { ...newPlacement('status', HEADER_GROUP_KEY), sort: 0 }
    ],
    rev: 'r'
  }
}

const labels = (f: string) => ({ title: 'Title', amount: 'Amount', vendor: 'Vendor name' })[f]
const shape = (nodes: NavNode[]): unknown[] =>
  nodes.map((n) =>
    n.children.length ? [`${n.kind}:${n.label}`, shape(n.children)] : `${n.kind}:${n.label}`
  )

describe('buildOutline', () => {
  it('lists the header strip, then the page in canvas order with steps inside their holder', () => {
    expect(shape(buildOutline(bundle(), null, labels))).toEqual([
      ['header:Header strip', ['field:Status']],
      ['section:Main', ['field:Title', 'field:Amount']],
      ['ungrouped:Ungrouped', ['field:Loose']],
      [
        'steps-holder:Flow',
        [
          ['step:Request', ['field:Vendor name']],
          ['step:Billing', ['field:Grand total']]
        ]
      ],
      'panel:Comments'
    ])
  })

  it('marks fields hidden here and what the parent layout supplies', () => {
    const parent: LayoutBundle = {
      ...bundle(),
      groups: [{ ...newGroup('legacy', 'Legacy', 'section', null), sort: 5 }],
      placements: [{ ...newPlacement('old_code', 'legacy'), sort: 0 }]
    }
    const nodes = buildOutline(bundle(), parent, labels)
    const amount = pathOf(nodes, { kind: 'field', field: 'amount', group_key: 'main' })
    expect(amount.map((n) => n.label)).toEqual(['Main'])
    const main = nodes.find((n) => n.key === 'main')
    expect(main?.children.find((n) => n.key === 'amount')?.hidden).toBe(true)
    const legacy = nodes.find((n) => n.key === 'legacy')
    expect(legacy?.inherited).toBe(true)
    expect(legacy?.children[0]).toMatchObject({ key: 'old_code', inherited: true })
  })
})

describe('crumbsOf', () => {
  it('names the holder and step a field sits in, outermost first', () => {
    const c = crumbsOf(bundle(), { kind: 'field', field: 'vendor', group_key: 'one' })
    expect(c.map((x) => [x.kind, x.label])).toEqual([
      ['steps-holder', 'Flow'],
      ['step', 'Request']
    ])
    expect(c[1].target).toEqual({ kind: 'group', key: 'one' })
  })

  it('a step names its holder; top-level sections, tiles and Ungrouped fields have none', () => {
    const b = bundle()
    expect(crumbsOf(b, { kind: 'group', key: 'two' }).map((x) => x.label)).toEqual(['Flow'])
    expect(crumbsOf(b, { kind: 'group', key: 'main' })).toEqual([])
    expect(crumbsOf(b, { kind: 'header', field: 'status' })).toEqual([])
    expect(crumbsOf(b, { kind: 'field', field: 'loose', group_key: null })).toEqual([])
  })
})

describe('find', () => {
  it('uses the Add panel matcher: any text containing the trimmed query, any case', () => {
    const m = textMatcher('  TOT ')
    expect(m('Grand total')).toBe(true)
    expect(m(null, 'x')).toBe(false)
    expect(textMatcher('')('anything')).toBe(true)
  })

  it('finds by label or key, hidden fields included, fields before sections', () => {
    const nodes = buildOutline(bundle(), null, labels)
    expect(findHits(nodes, 'total').map((h) => [h.node.label, h.where])).toEqual([
      ['Grand total', 'Flow › Billing']
    ])
    expect(findHits(nodes, 'amount').map((h) => h.node.hidden)).toEqual([true])
    // "re": Request (step) matches by label; fields first.
    const re = findHits(nodes, 're')
    expect(re[re.length - 1].node.kind).toBe('step')
    expect(findHits(nodes, '   ')).toEqual([])
  })

  it('a label match ranks above a key-only match', () => {
    const nodes = buildOutline(bundle(), null, labels)
    // total_cost matches "cost" by key only; nothing by label.
    expect(findHits(nodes, 'cost').map((h) => h.node.key)).toEqual(['total_cost'])
    expect(findHits(nodes, 'grand').map((h) => h.node.key)).toEqual(['total_cost'])
  })
})
