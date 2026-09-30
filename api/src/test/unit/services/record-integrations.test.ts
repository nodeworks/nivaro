import { describe, expect, it } from 'vitest'
import {
  describePushWhen,
  diffPayloads,
  humanizePayloadKey,
  summarizePayloadChanges
} from '../../../services/erp-push-gate.js'
import { callerOf, parseCallerKey } from '../../../services/inbound-attribution.js'
import { requirementIssues } from '../../../services/integration-preview.js'

describe('diffPayloads (#615)', () => {
  it('reports only leaves that differ, and treats null / absent / "2" vs 2 as the same', () => {
    const prev = { state: 'Level 1', po_number: null, qty: 2, lines: [{ q: 1 }, { q: 2 }] }
    const next = { state: 'Level 2', qty: '2', lines: [{ q: 1 }, { q: 3 }] }
    const d = diffPayloads(prev, next)
    expect(d.map((c) => c.path).sort()).toEqual(['lines[1].q', 'state'])
    expect(d.find((c) => c.path === 'state')).toMatchObject({ from: 'Level 1', to: 'Level 2' })
    expect(summarizePayloadChanges(d)).toEqual(['State', 'Lines'])
  })

  it('reads nothing-sent-yet as every leaf being new', () => {
    const d = diffPayloads(null, { a: 1, b: { c: 'x' } })
    expect(d.map((c) => c.path).sort()).toEqual(['a', 'b.c'])
  })

  it('caps the list', () => {
    const big = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]))
    expect(diffPayloads(null, big, 10)).toHaveLength(10)
  })
})

describe('humanizePayloadKey / describePushWhen', () => {
  it('reads keys as words, acronyms upper-case', () => {
    expect(humanizePayloadKey('po_number')).toBe('PO number')
    expect(humanizePayloadKey('requisitionId')).toBe('Requisition ID')
  })
  it('says when a push goes', () => {
    expect(describePushWhen(null)).toBe('Sent every time this transition runs')
    expect(describePushWhen({ state_change: false, payload: true })).toBe(
      'Sent when what it would send has changed'
    )
    expect(describePushWhen({ state_change: false, fields: ['po_number'] })).toBe(
      'Sent when PO number changed'
    )
  })
})

describe('requirementIssues (#616)', () => {
  it('groups incomplete lines by the field they lack and honours optional_when', () => {
    const issues = requirementIssues([
      {
        type: 'child_fields',
        collection: 'lines',
        fk_field: 'order',
        title: 'Lines',
        fields: [
          {
            field: 'sales_order',
            label: 'Sales order',
            type: 'string',
            optional_when: { field: 'warehouse', in: [3] }
          },
          { field: 'site', label: 'Site', type: 'string' }
        ],
        display_fields: [],
        rows: [
          {
            id: 1,
            label: 'Line 1',
            complete: false,
            values: { sales_order: null, site: null, warehouse: 1 },
            display: {}
          },
          {
            id: 2,
            label: 'Line 2',
            complete: false,
            values: { sales_order: '', site: 'A', warehouse: 1 },
            display: {}
          },
          {
            id: 3,
            label: 'Line 3',
            complete: false,
            values: { sales_order: null, site: null, warehouse: 3 },
            display: {}
          },
          {
            id: 4,
            label: 'Line 4',
            complete: true,
            values: { sales_order: 'S', site: 'B' },
            display: {}
          }
        ]
      },
      {
        type: 'record_fields',
        collection: 'orders',
        item: '9',
        title: 'Header',
        fields: [{ field: 'order_number', label: 'Order number', type: 'string' }],
        values: { order_number: null },
        display: {}
      }
    ])
    expect(issues).toEqual([
      {
        severity: 'block',
        message: '2 lines missing Sales order',
        collection: 'lines',
        fk_field: 'order',
        rows: [
          { id: '1', label: 'Line 1' },
          { id: '2', label: 'Line 2' }
        ]
      },
      {
        severity: 'block',
        message: '2 lines missing Site',
        collection: 'lines',
        fk_field: 'order',
        rows: [
          { id: '1', label: 'Line 1' },
          { id: '3', label: 'Line 3' }
        ]
      },
      { severity: 'block', message: 'Missing Order number', field: 'order_number' }
    ])
  })

  it('never lets an optional record_fields entry block', () => {
    expect(
      requirementIssues([
        {
          type: 'record_fields',
          collection: 'o',
          item: '1',
          title: 't',
          optional: true,
          fields: [{ field: 'x', label: 'X', type: 'string' }],
          values: {},
          display: {}
        }
      ])
    ).toEqual([])
  })
})

describe('callerOf (#617 / #609)', () => {
  const names = new Map([[12, 'Order sync']])
  it('names an API-key write by the key, whoever owns it', () => {
    expect(
      callerOf({ api_key_id: 12, auth_method: 'api_key', user: 'ADMIN', first_name: 'Ann' }, names)
    ).toMatchObject({ kind: 'api_key', name: 'Order sync', key: 'k12' })
  })
  it('names a token write by the account', () => {
    expect(
      callerOf(
        { auth_method: 'token', user: 'abc', first_name: 'Partner', last_name: 'Bot' },
        names
      )
    ).toMatchObject({ kind: 'token', name: 'Partner Bot', key: 'uABC' })
  })
  it('a session write is not inbound', () => {
    expect(callerOf({ auth_method: 'session', user: 'abc', first_name: 'Ann' }, names)).toBeNull()
  })
  it('reads a machine identity as inbound only for rows written before the stamping', () => {
    const row = {
      auth_method: null,
      user: 'u1',
      email: 'sync@nivaro.local',
      timestamp: '2026-01-01T00:00:00Z'
    }
    expect(callerOf(row, names, new Date('2026-06-01'))).toMatchObject({ kind: 'account' })
    expect(
      callerOf({ ...row, timestamp: '2026-07-01T00:00:00Z' }, names, new Date('2026-06-01'))
    ).toBeNull()
  })
  it('parses caller keys', () => {
    expect(parseCallerKey('k12')).toEqual({ kind: 'api_key', id: 12 })
    expect(parseCallerKey('u0a1b2c3d-0000-0000-0000-000000000000')).toEqual({
      kind: 'user',
      id: '0A1B2C3D-0000-0000-0000-000000000000'
    })
    expect(parseCallerKey('x')).toBeNull()
  })
})
