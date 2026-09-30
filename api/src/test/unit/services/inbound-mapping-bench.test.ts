import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/integration-remediation.js', () => ({
  classifyError: vi.fn(() => 'unknown')
}))

import {
  childRowsAt,
  fixturePayloadProblem,
  flattenPayload,
  judgeFixture,
  outcomeOf,
  parseChildren,
  parseFixtures,
  parseNestedError,
  parseResponseStatus,
  responseStatusProblem,
  shapeResponse,
  templateProblem
} from '../../../services/inbound-mapping-bench.js'

describe('payload paths', () => {
  it('flattens nested objects to dotted keys and keeps arrays whole', () => {
    const flat = flattenPayload({
      a: 1,
      order: { ref: 'X', to: { city: 'Rome' } },
      lines: [{ q: 1 }]
    })
    expect(flat['order.ref']).toBe('X')
    expect(flat['order.to.city']).toBe('Rome')
    expect(flat.order).toEqual({ ref: 'X', to: { city: 'Rome' } })
    expect(flat.lines).toEqual([{ q: 1 }])
    expect(flat['lines.0']).toBeUndefined()
  })

  it('finds child rows at a path, one object reading as one row', () => {
    expect(childRowsAt({ order: { lines: [{ a: 1 }, 5, { a: 2 }] } }, 'order.lines')).toEqual([
      { a: 1 },
      { a: 2 }
    ])
    expect(childRowsAt({ line: { a: 1 } }, 'line')).toEqual([{ a: 1 }])
    expect(childRowsAt({}, 'lines')).toBeNull()
  })

  it('names the child row of a nested refusal', () => {
    expect(
      parseNestedError('lines[3]: qty must be positive — nothing was created', 'lines')
    ).toEqual({ index: 3, message: 'qty must be positive — nothing was created' })
    expect(parseNestedError('something else', 'lines')).toEqual({
      index: null,
      message: 'something else'
    })
  })

  it('parses stored child rules and drops malformed ones', () => {
    expect(
      parseChildren('[{"target_field":"lines","source":"items","columns":[]},{"x":1}]')
    ).toHaveLength(1)
    expect(parseChildren('nope')).toEqual([])
  })
})

describe('fixtures', () => {
  it('parses stored fixtures, defaulting expect to write', () => {
    const f = parseFixtures(JSON.stringify([{ id: 'a', name: 'A', payload: {} }, { id: 1 }]))
    expect(f).toHaveLength(1)
    expect(f[0].expect).toBe('write')
  })

  it('refuses a payload that is not an object or too large', () => {
    expect(fixturePayloadProblem('x')).toMatch(/object or array/)
    expect(fixturePayloadProblem({ big: 'x'.repeat(70_000) })).toMatch(/at most/)
    expect(fixturePayloadProblem([{ a: 1 }])).toBeNull()
  })

  it('passes a write fixture only when every entry would write', () => {
    const ok = judgeFixture('write', {
      results: [
        { index: 0, action: 'preview', would: 'create', issues: [] },
        { index: 1, action: 'preview', would: 'update', issues: [] }
      ]
    })
    expect(ok).toEqual({ pass: true, reason: '1 would create, 1 would update' })
    const bad = judgeFixture('write', {
      results: [
        {
          index: 0,
          action: 'rejected',
          issues: [{ severity: 'error', rule: 'lookup', message: 'No vendor "ACME"' }]
        }
      ]
    })
    expect(bad).toEqual({ pass: false, reason: 'Entry 1: No vendor "ACME"' })
  })

  it('names the child row that refused', () => {
    const r = judgeFixture('write', {
      results: [
        {
          index: 0,
          action: 'rejected',
          issues: [],
          child_error: { field: 'lines', index: 2, message: 'price is required' }
        }
      ]
    })
    expect(r.reason).toBe('Entry 1: lines row 3 — price is required')
  })

  it('passes a reject fixture only when something is refused', () => {
    expect(
      judgeFixture('reject', { results: [{ index: 0, action: 'preview', issues: [] }] }).pass
    ).toBe(false)
    expect(
      judgeFixture('reject', {
        results: [{ index: 0, action: 'rejected', error: 'mapping errors', issues: [] }]
      }).pass
    ).toBe(true)
  })
})

describe('response shaping', () => {
  const base = {
    mapping: { key: 'orders', collection: 'orders' },
    results: [{ index: 0, action: 'created', id: 7, issues: [], values: { ref: 'A1' } }],
    created: 1,
    updated: 0,
    rejected: 0,
    records: [{ id: 7, ref: 'A1' }]
  }

  it('keeps the default body and status without a template', async () => {
    const r = await shapeResponse(base, null, {}, { data: 'default' })
    expect(r).toMatchObject({ status: 200, body: { data: 'default' }, shaped: false })
  })

  it('applies the status map without a template', async () => {
    const r = await shapeResponse(base, '', { success: 201 }, { data: 'default' })
    expect(r.status).toBe(201)
  })

  it('renders a JSON envelope from the record', async () => {
    const r = await shapeResponse(
      base,
      '{"ok": true, "orderId": {{ record.id | jsonify }}, "ref": {{ record.ref | jsonify }}}',
      { success: 201 },
      null
    )
    expect(r).toMatchObject({
      status: 201,
      body: { ok: true, orderId: 7, ref: 'A1' },
      content_type: 'application/json',
      shaped: true
    })
  })

  it('lists refusals in errors and uses the rejected status', async () => {
    const r = await shapeResponse(
      {
        ...base,
        results: [
          {
            index: 0,
            action: 'rejected',
            id: null,
            error: 'mapping errors',
            issues: [{ severity: 'error', rule: 'x', message: 'bad ref' }]
          }
        ],
        created: 0,
        rejected: 1,
        records: [null]
      },
      '{"ok": false, "errors": {{ errors | map: "message" | jsonify }}}',
      { rejected: 400 },
      null
    )
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ ok: false, errors: ['bad ref'] })
  })

  it('sends non-JSON output as text or xml', async () => {
    const xml = await shapeResponse(base, '<ack id="{{ record.id }}"/>', {}, null)
    expect(xml).toMatchObject({ content_type: 'application/xml', body: '<ack id="7"/>' })
  })

  it('falls back to the default body when the template fails to render', async () => {
    const r = await shapeResponse(base, '{{ record.id | nosuchfilter: }', {}, { data: 1 })
    expect(r.shaped).toBe(false)
    expect(r.body).toEqual({ data: 1 })
    expect(r.template_error).toBeTruthy()
  })

  it('judges outcomes and validates config', () => {
    expect(outcomeOf({ created: 1, updated: 0, rejected: 0 })).toBe('success')
    expect(outcomeOf({ created: 1, updated: 0, rejected: 1 })).toBe('partial')
    expect(outcomeOf({ created: 0, updated: 0, rejected: 2 })).toBe('rejected')
    expect(parseResponseStatus('{"success":201,"partial":"x","rejected":999}')).toEqual({
      success: 201
    })
    expect(responseStatusProblem({ success: 99 })).toMatch(/between 100 and 599/)
    expect(responseStatusProblem({ done: 200 })).toMatch(/unknown outcome/)
    expect(responseStatusProblem({ success: 201, partial: '' })).toBeNull()
    expect(templateProblem('{% if %}')).toMatch(/response_template/)
    expect(templateProblem('{"a": {{ record.id }}}')).toBeNull()
  })
})
