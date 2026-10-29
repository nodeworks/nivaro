import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ERROR_HINTS,
  enrichErrorBody,
  fieldsFromBody,
  hintFor,
  STATUS_HINTS
} from '../../../lib/error-hints.js'

describe('error hints', () => {
  it('the API and client tables are byte-identical twins', () => {
    const api = readFileSync(new URL('../../../lib/error-hints.ts', import.meta.url), 'utf8')
    const client = readFileSync(
      new URL('../../../../../packages/shared/src/lib/error-hints.ts', import.meta.url),
      'utf8'
    )
    expect(client).toBe(api)
  })

  it('every code has a plain hint that names nothing internal', () => {
    for (const [code, hint] of Object.entries(ERROR_HINTS)) {
      expect(hintFor(code, 400), code).toBe(hint)
      expect(hint.length, code).toBeGreaterThan(10)
      expect(hint, code).toMatch(/[.!]$/)
      expect(hint, code).not.toMatch(
        /select \*|insert into|constraint|nivaro_|dbo\.|\bsql\b|\bcolumn\b/i
      )
    }
  })

  it('an unknown code falls back to its status, then to the 4xx / 5xx default', () => {
    expect(hintFor('SOMETHING_NEW', 409)).toBe(STATUS_HINTS[409])
    expect(hintFor(undefined, 404)).toBe(STATUS_HINTS[404])
    expect(hintFor('X_Y', 418)).toBe(STATUS_HINTS[400])
    expect(hintFor(null, 599)).toBe(STATUS_HINTS[500])
    expect(hintFor(undefined, 200)).toBeUndefined()
  })

  it('reads the fields a refusal names', () => {
    expect(
      fieldsFromBody({
        error: 'x',
        violations: [{ field: 'zone', rule: 'required', message: 'Zone is required' }],
        field: 'supplier_site'
      })
    ).toEqual(['zone', 'supplier_site'])
    expect(fieldsFromBody({ error: 'workflow_lines[0]: Quantity can not be negative' })).toEqual([
      'workflow_lines'
    ])
    expect(fieldsFromBody({ error: 'x', missing: ['a', 'b c'] })).toEqual(['a'])
    expect(fieldsFromBody({ error: 'x', fields: [{ nested: true }] })).toEqual([])
  })

  it('adds hint, fields and request id without touching what the route sent', () => {
    const body = {
      error: 'Choose a Zone you have access to',
      code: 'OUT_OF_SCOPE',
      field: 'zone'
    }
    expect(enrichErrorBody(body, 422, { requestId: 'r-1' })).toEqual({
      ...body,
      hint: ERROR_HINTS.OUT_OF_SCOPE,
      fields: ['zone'],
      request_id: 'r-1'
    })
    // A route's own hint / fields / request id win.
    const own = { error: 'x', code: 'OUT_OF_SCOPE', hint: 'mine', fields: ['a'], request_id: 'z' }
    expect(enrichErrorBody(own, 422, { requestId: 'r-2' })).toBeNull()
  })

  it('a labelled database refusal replaces the generic sentence where the route put it', () => {
    const handler = {
      statusCode: 409,
      error: 'Conflict',
      message: 'A record with these values already exists (UX_po_number)',
      code: 'DUPLICATE_RECORD'
    }
    const out = enrichErrorBody(handler, 409, {
      message: 'Another record already has this PO number (4471)',
      hint: 'Use a different PO number, or open the existing record instead.',
      fields: ['po_number']
    })
    expect(out).toMatchObject({
      error: 'Conflict',
      code: 'DUPLICATE_RECORD',
      message: 'Another record already has this PO number (4471)',
      fields: ['po_number']
    })
    const route = { error: 'Supplier site needs a value', code: 'REQUIRED_VALUE_MISSING' }
    expect(
      enrichErrorBody(route, 422, { message: 'Supplier site is required', fields: ['site'] })
    ).toMatchObject({ error: 'Supplier site is required', code: 'REQUIRED_VALUE_MISSING' })
  })
})
