import { describe, expect, it } from 'vitest'
import { ERROR_HINTS, STATUS_HINTS } from './error-hints'
import { describeError, errorDetailsText, errorSentence, rowErrorSentence } from './error-message'
import { SOMETHING_WENT_WRONG, userErrorMessage } from './safe-error'

/** An SDK-shaped request error: the parsed body rides on `response`. */
const sdk = (status: number, body: Record<string, unknown>) =>
  Object.assign(new Error(String(body.error ?? 'Error')), { status, response: body })
/** An axios-shaped one: `response.data`, headers, "Request failed with status code N". */
const axios = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    code: 'ERR_BAD_REQUEST',
    response: { status, data, headers }
  })

describe('describeError', () => {
  it('every coded refusal gets its hint, even from a server that sent none', () => {
    for (const [code, hint] of Object.entries(ERROR_HINTS)) {
      const d = describeError(sdk(422, { error: `Refused (${code})`, code }))
      expect(d.code, code).toBe(code)
      expect(d.hint, code).toBe(hint)
      expect(d.title, code).toBe(`Refused (${code})`)
    }
  })

  it('the server’s own hint, fields and request id pass through unchanged', () => {
    const d = describeError(
      sdk(422, {
        error: 'Supplier site is required',
        code: 'REQUIRED_VALUE_MISSING',
        hint: 'Fill in Supplier site, then save again.',
        fields: ['supplier_site'],
        request_id: 'r-9'
      })
    )
    expect(d).toEqual({
      title: 'Supplier site is required',
      hint: 'Fill in Supplier site, then save again.',
      fields: ['supplier_site'],
      requestId: 'r-9',
      code: 'REQUIRED_VALUE_MISSING',
      status: 422,
      kind: 'validation'
    })
  })

  it('a partner explanation (integrations layer) passes through as the hint', () => {
    const d = describeError(
      sdk(422, {
        error: 'Fusion refused the purchase order',
        explanation: 'Add a supplier site to PO 4471, then try again.'
      })
    )
    expect(d.title).toBe('Fusion refused the purchase order')
    expect(d.hint).toBe('Add a supplier site to PO 4471, then try again.')
  })

  it('an unknown code falls back to the status hint', () => {
    const d = describeError(sdk(409, { error: 'Not now', code: 'BRAND_NEW_CODE' }))
    expect(d.hint).toBe(STATUS_HINTS[409])
    expect(d.action?.kind).toBe('reload')
    expect(d.code).toBe('BRAND_NEW_CODE')
  })

  it('never shows "Request failed with status code 409" or a bare status word', () => {
    const d = describeError(axios(409, ''))
    expect(d.title).toBe('Someone else changed this')
    expect(d.hint).toBe('Reload to see their changes, then make yours again.')
    expect(d.action).toEqual({ kind: 'reload', label: 'Reload' })
    expect(describeError(sdk(403, { error: 'Forbidden' })).title).toBe(
      'You do not have access to do this'
    )
    expect(userErrorMessage(axios(404, ''))).toBe('This could not be found')
  })

  it('axios: the global handler’s {error: status word, message} reads the message; header request id', () => {
    const d = describeError(
      axios(
        403,
        {
          statusCode: 403,
          error: 'Forbidden',
          message: 'Only the owner can move this',
          code: 'OWNER_ONLY'
        },
        { 'x-nivaro-request-id': 'abc' }
      )
    )
    expect(d.title).toBe('Only the owner can move this')
    expect(d.requestId).toBe('abc')
    expect(d.code).toBe('OWNER_ONLY')
  })

  it('reads fields from violations and nested line messages', () => {
    expect(
      describeError(
        sdk(400, {
          error: 'Zone is required',
          code: 'VALIDATION_RULE_FAILED',
          violations: [{ field: 'zone', rule: 'required', message: 'Zone is required' }]
        })
      ).fields
    ).toEqual(['zone'])
    expect(
      describeError(sdk(400, { error: 'workflow_lines[0]: Quantity can not be negative' })).fields
    ).toEqual(['workflow_lines'])
  })

  it('GraphQL errors read extensions.code', () => {
    const err = Object.assign(new Error('This record is locked'), {
      extensions: { code: 'EDIT_LOCKED', status: 403 }
    })
    const d = describeError(err)
    expect(d.title).toBe('This record is locked')
    expect(d.code).toBe('EDIT_LOCKED')
    expect(d.hint).toBe(ERROR_HINTS.EDIT_LOCKED)
  })

  it('no answer: the network, a timeout, a code error, nothing at all', () => {
    expect(describeError(new TypeError('Failed to fetch'))).toMatchObject({
      title: 'Cannot reach the server',
      hint: expect.stringMatching(/connection/)
    })
    expect(
      describeError(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' })).title
    ).toBe('Cannot reach the server')
    expect(
      describeError(
        Object.assign(new Error('Request timed out after 90s'), { name: 'TimeoutError' })
      ).title
    ).toBe('The server took too long to answer')
    expect(
      describeError(new TypeError("Cannot read properties of null (reading 'id')")).title
    ).toBe(SOMETHING_WENT_WRONG)
    expect(describeError(undefined, 'Save failed')).toEqual({
      title: 'Save failed',
      kind: 'unknown',
      hint: 'Try again. If it keeps happening, ask for help.',
      action: { kind: 'retry', label: 'Try again' }
    })
    expect(describeError(new Error('Lines did not save')).title).toBe('Lines did not save')
  })

  it('a transport code is not a refusal code', () => {
    expect(describeError(axios(500, { error: 'Boom' })).code).toBeUndefined()
  })
})

describe('copy details and one-line forms', () => {
  it('details carry what happened, what to do, code, fields and request id', () => {
    const text = errorDetailsText(
      describeError(
        sdk(409, {
          error: 'Someone saved this record while you were editing',
          code: 'MIDAIR_COLLISION',
          request_id: 'req-1'
        })
      ),
      { action: 'Save record', now: new Date('2026-10-29T12:00:00Z'), page: '/collections/po/1' }
    )
    expect(text).toBe(
      [
        'Action: Save record',
        'What happened: Someone saved this record while you were editing',
        `What to do: ${ERROR_HINTS.MIDAIR_COLLISION}`,
        'Code: MIDAIR_COLLISION · HTTP 409',
        'Request id: req-1',
        'Page: /collections/po/1',
        'When: 2026-10-29T12:00:00.000Z'
      ].join('\n')
    )
  })

  it('errorSentence joins title and hint once', () => {
    expect(errorSentence(sdk(429, { error: 'Slow down.', code: 'RATE_LIMITED' }))).toBe(
      `Slow down. ${ERROR_HINTS.RATE_LIMITED}`
    )
  })

  it('import row errors read as plain sentences, old stored ones included', () => {
    expect(
      rowErrorSentence("Warehouse 'X' doesn't exist — check the spelling or add it first")
    ).toBe("Warehouse 'X' doesn't exist — check the spelling or add it first")
    expect(
      rowErrorSentence(
        'insert into [po] ([w]) values (@p0) - The INSERT statement conflicted with the FOREIGN KEY constraint "fk_po_w". The conflict occurred in database "prod", table "dbo.w".'
      )
    ).toBe(
      'A linked value in this row does not exist — check the spelling or add that record first'
    )
    expect(
      rowErrorSentence(
        "insert into [po] ([a]) values (@p0) - Cannot insert the value NULL into column 'supplier_site', table 'prod.dbo.po'; column does not allow nulls. INSERT fails."
      )
    ).toBe('supplier site is empty — fill it in the file or map a column to it')
    expect(rowErrorSentence('')).toBe('This row was not imported')
  })
})
