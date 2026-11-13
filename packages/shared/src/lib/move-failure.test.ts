import { describe, expect, it } from 'vitest'
import { partnerMoveFailure } from './move-failure'

// A move that calls another system and is refused answers 422 with the reason as stored:
// 'Submit to Warehouse: submission failed — HTTP 400: "The project is not valid"'. The toast
// read that like any other error, so the status line hid the one sentence the person needs.
// It now says what the row for a background move says (owner's call, 2026-11-12).

/** An SDK-shaped request error: the parsed body rides on `response`. */
function sdkError(status: number, body: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status ${status}`), {
    status,
    response: { status, ...body }
  })
}
const refused = (answer: string, label = 'Submit to Warehouse') =>
  sdkError(422, { error: `${label}: submission failed — ${answer}` })

describe('a failed move’s toast when another system refused it', () => {
  it('names the move and shows what the other system answered, in its own words', () => {
    expect(
      partnerMoveFailure(refused('HTTP 400: "The project is not valid"'), 'Submit to Warehouse')
    ).toEqual({
      title: 'Submit to Warehouse did not go through',
      description: 'Submission failed: The project is not valid'
    })
  })

  it('reads the same body from an axios-shaped error', () => {
    const err = Object.assign(new Error('Request failed with status code 422'), {
      response: {
        status: 422,
        data: {
          error:
            'Submit to Warehouse: submission failed — HTTP 400: {"message":"Task 1000 is not in the list of values"}'
        }
      }
    })
    expect(partnerMoveFailure(err, 'Submit to Warehouse')).toEqual({
      title: 'Submit to Warehouse did not go through',
      description: 'Submission failed: Task 1000 is not in the list of values'
    })
  })

  it('with no sentence in the answer, says what it means about the other system', () => {
    expect(partnerMoveFailure(refused('HTTP 502: null'), 'Submit to Warehouse')?.description).toBe(
      'The other system is not answering right now.'
    )
    const signIn = partnerMoveFailure(refused('HTTP 401: ""'), 'Submit to Warehouse')
    expect(signIn?.description).toBe(
      'The other system did not accept this app’s sign-in. An administrator needs to check the connection.'
    )
    expect(JSON.stringify(signIn)).not.toMatch(/signed out/i)
    expect(
      partnerMoveFailure(
        refused('fetch failed (Error: connect ECONNREFUSED 10.0.0.1:443)'),
        'Submit to Warehouse'
      )?.description
    ).toBe('The other system could not be reached.')
  })

  it('never shows the status line, in the title or under it', () => {
    const said = partnerMoveFailure(
      refused('HTTP 400: "The project is not valid"'),
      'Submit to Warehouse'
    )
    expect(JSON.stringify(said)).not.toMatch(/HTTP|400/)
  })

  it('the move’s name comes from the caller, whatever its letter case in the stored text', () => {
    expect(
      partnerMoveFailure(
        sdkError(422, { error: 'SUBMIT TO WAREHOUSE: submission failed — HTTP 400: "No stock"' }),
        'Submit to Warehouse'
      )
    ).toEqual({
      title: 'Submit to Warehouse did not go through',
      description: 'Submission failed: No stock'
    })
  })

  it('without a name from the caller, the title still reads as a sentence', () => {
    expect(partnerMoveFailure(refused('HTTP 400: "The project is not valid"'), null)).toEqual({
      title: 'The move did not go through',
      description: 'Submit to Warehouse: submission failed: The project is not valid'
    })
  })

  // Design review: only a move's OWN call to another system is the other system's. A fault of
  // this app (a 500 whose text names a socket error or a status) must keep its usual toast,
  // or everyone is pointed at the partner while this app is the one in trouble.
  it('nothing for this app’s own server fault, whatever words its text carries', () => {
    const fault = (message: string) =>
      sdkError(500, { statusCode: 500, error: 'Internal Server Error', message })
    for (const message of [
      'connect ECONNREFUSED 127.0.0.1:6679',
      'read ECONNRESET',
      'getaddrinfo ENOTFOUND smtp.internal',
      'Budget service answered HTTP 503',
      'fetch failed'
    ])
      expect(partnerMoveFailure(fault(message), 'Submit to Warehouse')).toBeNull()
  })

  it('still reads every shape of a move’s own partner call', () => {
    const shown = (answer: string) =>
      partnerMoveFailure(refused(answer), 'Submit to Warehouse')?.description
    expect(shown('fetch failed (after 2 retries)')).toBe('The other system could not be reached.')
    expect(shown('Timed out after 30000ms')).toBe('The other system took too long to answer.')
    expect(shown('Token exchange failed (HTTP 401): invalid_client')).toBe(
      'The other system did not accept this app’s sign-in. An administrator needs to check the connection.'
    )
  })

  it('nothing for a refusal that is not another system’s: the toast stays as it was', () => {
    expect(
      partnerMoveFailure(
        sdkError(422, { error: 'Submit to Warehouse: contact email is required' }),
        'Submit to Warehouse'
      )
    ).toBeNull()
    expect(
      partnerMoveFailure(
        sdkError(403, {
          statusCode: 403,
          error: 'Forbidden',
          message: 'Only the owner of Engineering Review can make this move.',
          code: 'TRANSITION_OWNER_REQUIRED'
        }),
        'Approve'
      )
    ).toBeNull()
    expect(partnerMoveFailure(new Error('Network down'), 'Approve')).toBeNull()
    expect(partnerMoveFailure(null, 'Approve')).toBeNull()
  })
})
