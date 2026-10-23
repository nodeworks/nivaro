import { describe, expect, it } from 'vitest'
import type { Field, MapSpec, Problem } from './api'
import { collectionWord, humanizePath } from './field-map/labels'
import { outputPathLabel, problemCopy, shortRecordLabel } from './problem-copy'

const f = (over: Partial<Field> & Pick<Field, 'id' | 'key'>): Field => ({
  type: 'text',
  include: 'always',
  ...over
})

const spec: MapSpec = {
  v: 1,
  fields: [
    f({ id: 'site', key: 'toSiteId' }),
    f({
      id: 'lines',
      key: 'orderDetails',
      type: 'list',
      list: { source: 'context.materials', item: 'material' },
      children: [f({ id: 'qty', key: 'whToQuantity', type: 'number' })]
    })
  ]
}

const p = (over: Partial<Problem>): Problem => ({
  field_id: 'x',
  path: '',
  message: 'server message',
  severity: 'error',
  ...over
})

const opts = { recordLabel: 'IR-004818 · Node split staging — Bucks County', spec }

describe('problemCopy', () => {
  it('names the record and the field plainly for a missing value, raw path only in the tip', () => {
    const c = problemCopy(
      p({
        code: 'no_value',
        severity: 'warning',
        path: 'toSiteId',
        message: 'context.shipping_location[0].inventory_org has no value on this record',
        params: { source: 'context.shipping_location[0].inventory_org' }
      }),
      opts
    )
    expect(c.text).toBe(
      'IR-004818 has no Shipping location → Inventory org. Set it on the record, or add an else value.'
    )
    expect(c.text).not.toContain('context.')
    expect(c.tip).toContain('toSiteId')
    expect(c.tip).toContain('context.shipping_location[0].inventory_org')
  })

  it('names a list item by its list ("Material 1") for a type problem', () => {
    const c = problemCopy(
      p({
        code: 'type_number',
        path: 'orderDetails[0].whToQuantity',
        params: { got: 'two', source: 'material.quantity' }
      }),
      opts
    )
    expect(c.text).toBe(
      'Material 1 → Quantity is ‘two’, not a number. Fix it on the record, or pick a different value.'
    )
  })

  it('says the item owns a missing value inside a list', () => {
    const c = problemCopy(
      p({
        code: 'no_value',
        path: 'orderDetails[2].whToQuantity',
        params: { source: 'material.cifa_data.cifa_number' }
      }),
      opts
    )
    expect(c.text).toBe(
      'Material 3 has no Cifa → Cifa number. Set it on the record, or add an else value.'
    )
  })

  it('a required field says it is required', () => {
    const c = problemCopy(
      p({ code: 'rule_required', path: 'toSiteId', params: { source: 'record.site' } }),
      opts
    )
    expect(c.text).toBe(
      'IR-004818 has no Site, and toSiteId is required. Set it on the record, or add an else value.'
    )
  })

  it('rule codes compose from their params', () => {
    expect(
      problemCopy(
        p({ code: 'rule_max_length', path: 'toSiteId', params: { length: 12, max: 9 } }),
        opts
      ).text
    ).toBe(
      'toSiteId is 12 characters; at most 9 are allowed. Add a First N characters step, or shorten it on the record.'
    )
    expect(
      problemCopy(
        p({ code: 'rule_min', path: 'orderDetails[1].whToQuantity', params: { got: 0, min: 1 } }),
        opts
      ).text
    ).toBe('Material 2 → whToQuantity is 0; the lowest allowed is 1.')
    expect(
      problemCopy(
        p({ code: 'rule_allowed', path: 'toSiteId', params: { got: 'X', allowed: ['A', 'B'] } }),
        opts
      ).text
    ).toBe('toSiteId is ‘X’, which isn’t one of the allowed values (A, B).')
  })

  it('secrets, keys and locked keys get their fix', () => {
    expect(problemCopy(p({ code: 'secret_unknown', params: { name: 'apiKey' } })).text).toBe(
      'This API has no apiKey secret yet. Add it under Body secrets on the API page.'
    )
    expect(problemCopy(p({ code: 'duplicate_key', path: 'po', params: { key: 'po' } })).text).toBe(
      'Two fields here are named po. Rename one of them.'
    )
    expect(
      problemCopy(p({ code: 'locked_missing', path: 'status', params: { key: 'status' } }), {
        partner: 'Fusion IIP'
      }).text
    ).toBe(
      'Fusion IIP needs status, but it’s no longer in the field map. Add it back, or reset to the file default.'
    )
  })

  it('without a record label says "This record"', () => {
    expect(
      problemCopy(p({ code: 'no_value', path: 'a', params: { source: 'record.notes' } })).text
    ).toBe('This record has no Notes. Set it on the record, or add an else value.')
  })

  it('an unknown or missing code falls back to the server message', () => {
    expect(problemCopy(p({ code: 'something_new', message: 'Raw words' })).text).toBe('Raw words')
    expect(problemCopy(p({ message: 'Older server' })).text).toBe('Older server')
  })
})

describe('outputPathLabel / shortRecordLabel', () => {
  it('labels list items by the list source and keeps keys', () => {
    expect(outputPathLabel('orderDetails[0].whToQuantity', spec.fields).label).toBe(
      'Material 1 → whToQuantity'
    )
    expect(outputPathLabel('toSiteId', spec.fields).label).toBe('toSiteId')
    expect(outputPathLabel('unknown[1].x', spec.fields).label).toBe('unknown 2 → x')
  })

  it('keeps the record number', () => {
    expect(shortRecordLabel('IR-004818 · Node split')).toBe('IR-004818')
    expect(shortRecordLabel('')).toBeNull()
    expect(shortRecordLabel(null)).toBeNull()
  })
})

describe('humanizePath with collection names', () => {
  const names = {
    relCollection: { mwf_queue: 'mwf_queues', po_id: 'purchase_orders' },
    collectionLabel: {
      mwf_queues: 'MWF queue',
      purchase_orders: collectionWord('Purchase Orders')
    },
    acronyms: new Set(['MWF', 'PO'])
  }

  it('names a relation hop by the related collection and keeps acronyms', () => {
    expect(humanizePath('record.mwf_queue.mwf_id', null, names)).toBe('MWF queue → MWF id')
    expect(humanizePath('record.po_id.number', null, names)).toBe('Purchase order → Number')
    expect(humanizePath('record.po_number', null, names)).toBe('PO number')
    expect(humanizePath('record.mwf_queue.mwf_id')).toBe('Mwf queue → Mwf id')
    expect(humanizePath('context.pos[0].purchase_order_data.number', null, names)).toBe(
      'Purchase order → Number'
    )
    expect(humanizePath('context.fusion_warehouse[0].location_data.inventory_org')).toBe(
      'Fusion warehouse → Location → Inventory org'
    )
  })
})
