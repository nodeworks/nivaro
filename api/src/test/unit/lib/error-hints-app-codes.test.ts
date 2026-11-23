import { describe, expect, it } from 'vitest'
import { enrichErrorBody, hintFor, STATUS_HINTS } from '../../../lib/error-hints.js'
import { retiredRefusalBody } from '../../../services/hub-link/retire.js'

// Hub phase 6 parked wave (T9): a retired app's 503 APP_MOVED used to gain the generic 503 hint
// "The server is busy or restarting" from the error-enrich layer. The Hub's app codes now carry
// their own hints.

describe('Hub app codes', () => {
  it.each([
    'APP_MOVED',
    'APP_STATE_UNKNOWN',
    'APP_MAINTENANCE',
    'APP_NOT_READY'
  ])('%s has its own hint, never the busy-server one', (code) => {
    const hint = hintFor(code, 503)
    expect(hint).toBeTruthy()
    expect(hint).not.toBe(STATUS_HINTS[503])
    expect(hint).not.toMatch(/busy|restarting/i)
  })

  it('the retire refusal is enriched with "reload … new home"', () => {
    const body = enrichErrorBody({ ...retiredRefusalBody() }, 503)
    expect(body?.hint).toMatch(/Reload the page to reach the app at its new home/)
  })
})
