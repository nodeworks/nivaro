import { describe, expect, it } from 'vitest'
import { jobFailureText } from './job-failure-text'

// Browser test 2026-11-12: a background move that MDSi refused showed, in the Jobs tray at the
// bottom of every page, 'Submit to Warehouse: submission failed — Token exchange failed
// (HTTP 403): Client "jeqo…" is…' — the stored status line, with the partner's client id in
// it. The row and the toast for the same failure already said it in plain words.

describe('what the Jobs tray says for a job that failed', () => {
  it('a move another system refused: what that system answered, never the status line', () => {
    const shown = jobFailureText(
      'Submit to Warehouse: submission failed — Token exchange failed (HTTP 403): Client "jeqoAX7m8hjMFn0PY2FsDH8tPrtvCw68" is not authorized'
    )
    expect(shown).toBe(
      'The other system did not accept this app’s sign-in. An administrator needs to check the connection.'
    )
    expect(shown).not.toMatch(/HTTP|403|jeqo|Client/)
  })

  it('the other system’s own sentence when it gave one', () => {
    expect(
      jobFailureText(
        'Submit to Warehouse: submission failed — HTTP 400: "The project is not valid"'
      )
    ).toBe('Submission failed: The project is not valid')
  })

  it('plain words from any other job show as they are', () => {
    expect(jobFailureText('Row 12: the vendor was not found')).toBe(
      'Row 12: the vendor was not found'
    )
    expect(jobFailureText('Stopped by Dana Whitfield')).toBe('Stopped by Dana Whitfield')
  })

  it('raw text from any job is read, not shown', () => {
    const sql = jobFailureText("Invalid column name 'vendor_site'.")
    expect(sql).not.toMatch(/vendor_site|Invalid column/)
    expect(sql?.length).toBeGreaterThan(3)
    const stack = jobFailureText("TypeError: Cannot read properties of undefined (reading 'id')")
    expect(stack).not.toMatch(/TypeError|undefined/)
  })

  it('nothing to say gives nothing', () => {
    expect(jobFailureText(null)).toBeNull()
    expect(jobFailureText('   ')).toBeNull()
  })
})
