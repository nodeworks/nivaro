import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { saveSupportDraft, supportDraftFor, takeSupportDraft } from './error-actions'
import { ERROR_HINTS } from './error-hints'
import {
  ASK_FOR_HELP_HINT,
  describeError,
  describeLoadError,
  type ErrorDescription,
  errorDetailsText,
  errorFieldList
} from './error-message'
import { errorToastOptions, guardErrorToasts, resetErrorToastGuardForTests } from './error-toast'
import {
  isRawErrorText,
  plainErrorText,
  SOMETHING_WENT_WRONG,
  userErrorMessage
} from './safe-error'

/** An SDK-shaped error (NivaroError): status, parsed body on `response`, request id. */
const sdk = (status: number, body: Record<string, unknown> | null, requestId = 'req-42') =>
  Object.assign(new Error(String(body?.error ?? body?.message ?? `HTTP ${status}`)), {
    status,
    response: body ?? { error: '' },
    requestId
  })
/** The global handler's shape for a crash: `{statusCode, error: <status word>, message: <raw>}`. */
const crash = (message: string) =>
  sdk(500, { statusCode: 500, error: 'Internal Server Error', message })
/** efp-new's ApiError: status 0 = the request never got an answer. */
const apiError = (message: string, status: number, response?: unknown) =>
  Object.assign(new Error(message), { name: 'ApiError', status, response })

/** Everything a person reads: the title and the hint. */
const shown = (d: ErrorDescription) => `${d.title}\n${d.hint ?? ''}`

/** Nothing raw on screen: no status number, no request id, no code, no technical text. */
function expectNothingRaw(d: ErrorDescription) {
  const text = shown(d)
  expect(text).not.toMatch(/\b[1-5]\d{2}\b/)
  expect(text).not.toMatch(/request failed|status code|HTTP|stack|undefined|null\b/i)
  if (d.requestId) expect(text).not.toContain(d.requestId)
  if (d.code) expect(text).not.toContain(d.code)
  if (d.technical) expect(text).not.toContain(d.technical)
  expect(isRawErrorText(d.title)).toBe(false)
  if (d.hint) expect(isRawErrorText(d.hint)).toBe(false)
}

describe('describeError — one shape for every failure', () => {
  const online = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  afterEach(() => {
    if (online) Object.defineProperty(globalThis, 'navigator', online)
    else delete (globalThis as { navigator?: unknown }).navigator
  })

  const cases: Array<[string, unknown, Partial<ErrorDescription>]> = [
    [
      'network',
      new TypeError('Failed to fetch'),
      {
        kind: 'network',
        title: 'Cannot reach the server',
        action: { kind: 'retry', label: 'Try again' }
      }
    ],
    [
      'portal ApiError status 0',
      apiError('Cannot reach the EFP server — retrying in the background.', 0),
      { kind: 'network', title: 'Cannot reach the server' }
    ],
    [
      'timeout',
      Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }),
      {
        kind: 'timeout',
        title: 'The server took too long to answer',
        action: { kind: 'retry', label: 'Try again' }
      }
    ],
    [
      '401 signed out',
      sdk(401, { statusCode: 401, error: 'Unauthorized', message: 'Unauthorized' }),
      {
        kind: 'signed-out',
        title: 'You’ve been signed out',
        action: { kind: 'sign-in', label: 'Sign in again' }
      }
    ],
    [
      '403 not allowed',
      sdk(403, { statusCode: 403, error: 'Forbidden', message: 'Forbidden' }),
      {
        kind: 'forbidden',
        title: 'You do not have access to do this',
        hint: ERROR_HINTS.FORBIDDEN,
        action: { kind: 'contact', label: 'Ask for access' }
      }
    ],
    [
      '404 not found',
      sdk(404, { error: 'Not Found' }),
      {
        kind: 'not-found',
        title: 'This could not be found',
        action: { kind: 'go-back', label: 'Go back' }
      }
    ],
    [
      '409 someone else changed it',
      sdk(409, {
        error: 'Someone saved this record while you were editing',
        code: 'MIDAIR_COLLISION'
      }),
      {
        kind: 'conflict',
        title: 'Someone saved this record while you were editing',
        hint: ERROR_HINTS.MIDAIR_COLLISION,
        action: { kind: 'reload', label: 'Reload' }
      }
    ],
    [
      '413 too big',
      sdk(413, {
        statusCode: 413,
        error: 'Payload Too Large',
        message: 'Request body is too large'
      }),
      { kind: 'too-large', title: 'Request body is too large' }
    ],
    [
      '429 slow down',
      sdk(429, { error: 'Too Many Requests', code: 'RATE_LIMITED' }),
      {
        kind: 'rate-limited',
        title: 'Too many requests in a short time',
        hint: ERROR_HINTS.RATE_LIMITED,
        action: { kind: 'retry', label: 'Try again' }
      }
    ],
    [
      'maintenance',
      sdk(503, { error: 'Back at 6 PM. The system is being updated.', code: 'MAINTENANCE' }),
      {
        kind: 'maintenance',
        title: 'Back at 6 PM. The system is being updated.',
        hint: ERROR_HINTS.MAINTENANCE,
        action: { kind: 'reload', label: 'Reload' }
      }
    ],
    [
      '503 busy',
      sdk(503, {
        statusCode: 503,
        error: 'Service Unavailable',
        message: 'The server is busy right now. Please try again in a few seconds.',
        code: 'SERVER_BUSY'
      }),
      {
        kind: 'unavailable',
        title: 'The server is busy right now. Please try again in a few seconds.',
        action: { kind: 'retry', label: 'Try again' }
      }
    ],
    [
      '502 with no body',
      sdk(502, null),
      {
        kind: 'unavailable',
        title: 'The server is not answering right now',
        action: { kind: 'retry', label: 'Try again' }
      }
    ],
    [
      '500 crash with raw text',
      crash("Cannot read properties of undefined (reading 'zone')"),
      {
        kind: 'server',
        title: 'Something went wrong on the server',
        hint: ASK_FOR_HELP_HINT,
        action: { kind: 'retry', label: 'Try again' },
        technical: "Cannot read properties of undefined (reading 'zone')"
      }
    ],
    [
      '500 crash with a plain-looking message stays generic',
      crash('Request timeout'),
      { kind: 'server', title: 'Something went wrong on the server' }
    ],
    [
      'code error',
      new TypeError("Cannot read properties of null (reading 'id')"),
      {
        kind: 'bug',
        title: SOMETHING_WENT_WRONG,
        action: { kind: 'reload', label: 'Reload the page' }
      }
    ]
  ]

  for (const [name, err, want] of cases) {
    it(name, () => {
      const d = describeError(err)
      expect(d).toMatchObject(want)
      expectNothingRaw(d)
    })
  }

  it('offline says so, and keeps the work', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: false },
      configurable: true
    })
    const d = describeError(new TypeError('Failed to fetch'))
    expect(d).toMatchObject({ kind: 'offline', title: 'You’re offline', action: { kind: 'retry' } })
    expect(d.hint).toMatch(/internet connection/)
  })

  it('422 lists the fields in plain words when the server gave no hint', () => {
    const d = describeError(
      sdk(422, {
        error: 'Some values need fixing',
        violations: [{ field: 'supplier_site' }, { field: 'needByDate' }, { field: 'lines.0.qty' }]
      })
    )
    expect(d.kind).toBe('validation')
    expect(d.hint).toBe('Check Supplier site, Need by date and Qty, then try again.')
    expect(d.action).toBeUndefined()
    expect(d.fields).toEqual(['supplier_site', 'needByDate', 'lines.0.qty'])
    // The form's own labels win.
    expect(
      describeError(sdk(422, { error: 'x', fields: ['zone_id'] }), undefined, {
        fieldLabels: { zone_id: 'Zone' }
      }).hint
    ).toBe('Check Zone, then try again.')
  })

  it('errorFieldList folds a long list', () => {
    expect(errorFieldList(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('A, B, C and 3 more')
  })

  it('raw server sentences never become the title; they stay in technical', () => {
    const sql = sdk(400, {
      error:
        'insert into [po] ([w]) values (@p0) - The INSERT statement conflicted with the FOREIGN KEY constraint "fk_po_w"'
    })
    const d = describeError(sql)
    expect(d.title).toBe('That request could not be completed')
    expect(d.technical).toMatch(/INSERT statement/)
    expectNothingRaw(d)
    const uuid = describeError(
      sdk(404, { error: 'Layout 3f0a9c2e-1b2c-4d5e-8f90-123456789abc was not found' })
    )
    expect(uuid.title).toBe('This could not be found')
    expectNothingRaw(uuid)
  })

  it('the details text carries what support needs, the title never does', () => {
    const d = describeError(crash('ECONNREFUSED 10.1.2.3:1433'))
    expectNothingRaw(d)
    const text = errorDetailsText(d, { now: new Date('2026-10-30T12:00:00Z'), page: '/budget' })
    expect(text).toContain('Request id: req-42')
    expect(text).toContain('Technical: ECONNREFUSED 10.1.2.3:1433')
    expect(text).toContain('HTTP 500')
  })

  it('a failed read says what could not be loaded', () => {
    expect(describeLoadError(crash('boom at x.ts:12:3'), 'the dashboard')).toMatchObject({
      title: 'Couldn’t load the dashboard',
      hint: ASK_FOR_HELP_HINT,
      action: { kind: 'retry' }
    })
    // Specific readings keep their own words.
    expect(describeLoadError(sdk(403, { error: 'Forbidden' }), 'the dashboard').title).toBe(
      'You do not have access to do this'
    )
  })
})

describe('raw text detection', () => {
  it.each([
    'Request failed with status code 500',
    'Request failed (500)',
    'HTTP 403',
    '500 Internal Server Error',
    'Forbidden',
    "TypeError: Cannot read properties of null (reading 'id')",
    'x.map is not a function',
    'Error: boom\n    at foo (app.js:1:2)',
    "Invalid column name 'zone'.",
    'Violation of UNIQUE KEY constraint',
    'connect ECONNREFUSED 127.0.0.1:1433',
    'Timeout: Request failed to complete in 15000ms',
    'select * from nivaro_users where id = 1',
    'Unexpected token < in JSON at position 0',
    'Record 3f0a9c2e-1b2c-4d5e-8f90-123456789abc not found',
    '[object Object]'
  ])('%s is raw', (t) => expect(isRawErrorText(t)).toBe(true))

  it.each([
    'Supplier site is required',
    'Someone saved this record while you were editing',
    'The server is busy right now. Please try again in a few seconds.',
    'PO 4471 needs a supplier site before it can go to Fusion'
  ])('%s is plain', (t) => expect(isRawErrorText(t)).toBe(false))

  it('plainErrorText keeps the plain lead and drops the raw tail', () => {
    expect(plainErrorText('Density not saved — Request failed (500)')).toBe(
      'Density not saved. Something went wrong on the server'
    )
    expect(plainErrorText("Not saved: Cannot read properties of null (reading 'x')")).toBe(
      'Not saved'
    )
    expect(plainErrorText('Request failed with status code 403')).toBe(
      'You do not have access to do this'
    )
    expect(plainErrorText('Failed to fetch')).toBe('Cannot reach the server')
  })

  it('userErrorMessage never passes raw text through', () => {
    expect(userErrorMessage(apiError('Request failed (500)', 500, null))).toBe(
      'Something went wrong on the server'
    )
    expect(userErrorMessage(crash('Invalid object name nivaro_x'), 'Save failed')).toBe(
      'Something went wrong on the server'
    )
    expect(userErrorMessage(sdk(422, { error: 'Zone is required' }))).toBe('Zone is required')
  })
})

describe('toasts', () => {
  beforeEach(() => resetErrorToastGuardForTests())

  it('the button is the one that helps', () => {
    const retry = vi.fn()
    expect(errorToastOptions(sdk(503, null), { retry }).action?.label).toBe('Try again')
    expect(errorToastOptions(sdk(401, { error: 'Unauthorized' })).action?.label).toBe(
      'Sign in again'
    )
    expect(errorToastOptions(sdk(403, { error: 'Forbidden' })).action?.label).toBe('Ask for access')
    expect(errorToastOptions(crash('boom')).action?.label).toBe('Get help')
    expect(
      errorToastOptions(sdk(422, { error: 'Zone is required', fields: ['zone'] }, '')).action
    ).toBeUndefined()
    // No retry handed in for a busy server: the hint says when; the reference is copyable.
    expect(errorToastOptions(sdk(503, null)).action?.label).toBe('Copy details')
  })

  it('the guard turns raw toast text into plain words', () => {
    const calls: unknown[][] = []
    const target = { error: ((...a: unknown[]) => calls.push(a)) as never }
    guardErrorToasts(target)
    ;(target.error as (...a: unknown[]) => void)('Request failed with status code 403')
    ;(target.error as (...a: unknown[]) => void)('Saved with a warning')
    ;(target.error as (...a: unknown[]) => void)(crash('boom at y.ts:1:1'))
    ;(target.error as (...a: unknown[]) => void)('Not saved', { description: 'HTTP 500' })
    expect(calls[0][0]).toBe('You do not have access to do this')
    expect((calls[0][1] as { description?: string }).description).toBe(ERROR_HINTS.FORBIDDEN)
    expect(calls[1][0]).toBe('Saved with a warning')
    expect(calls[2][0]).toBe('Something went wrong on the server')
    expect((calls[3][1] as { description?: string }).description).toBeUndefined()
  })
})

describe('support draft', () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    ;(globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k)
    }
  })

  it('is taken once, carries the reference, and goes stale', () => {
    const d = describeError(crash('boom'))
    saveSupportDraft(supportDraftFor(d, { action: 'Save record' }), 1000)
    const draft = takeSupportDraft(2000)
    expect(draft?.title).toBe('Something went wrong on the server')
    expect(draft?.description).toContain('Request id: req-42')
    expect(draft?.description).toContain('Action: Save record')
    expect(takeSupportDraft(2000)).toBeNull()
    saveSupportDraft({ title: 'x', description: 'y' }, 0)
    expect(takeSupportDraft(16 * 60_000)).toBeNull()
  })
})
