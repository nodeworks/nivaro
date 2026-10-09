import { describe, expect, it } from 'vitest'
import { plainFailure, sentence, serverMessage, stopsRecording } from './failure'

const refusal = (status: number, body: Record<string, unknown>, message = 'x') =>
  Object.assign(new Error(message), { status, response: body })

describe('serverMessage', () => {
  it("prefers Fastify's message over its HTTP reason", () => {
    expect(serverMessage({ error: 'Conflict', message: 'This upload is already finished' })).toBe(
      'This upload is already finished'
    )
  })
  it("falls back to a route's own error sentence", () => {
    expect(serverMessage({ error: 'Only video authors can do this' })).toBe(
      'Only video authors can do this'
    )
    expect(serverMessage({ error: '  ', message: '' })).toBeUndefined()
  })
})

describe('plainFailure', () => {
  it('shows the server sentence, ended with a full stop', () => {
    const f = plainFailure(
      refusal(
        409,
        { error: 'Conflict', message: 'This upload is already finished', code: 'UPLOAD_CLOSED' },
        'Conflict'
      )
    )
    expect(f).toEqual({
      message: 'This upload is already finished.',
      retryable: false,
      closed: true
    })
    expect(sentence('Done!')).toBe('Done!')
  })
  it('classifies refusals as final and outages as retryable', () => {
    expect(
      plainFailure(
        refusal(422, { message: 'Recordings can be up to 30 minutes', code: 'UPLOAD_TOO_LONG' })
      ).retryable
    ).toBe(false)
    expect(
      plainFailure(refusal(409, { message: 'Held elsewhere', code: 'UPLOAD_ELSEWHERE' })).retryable
    ).toBe(true)
    expect(plainFailure(refusal(503, { error: 'The server is restarting' })).retryable).toBe(true)
    // A part PUT carries `code` on the error itself.
    expect(
      plainFailure(Object.assign(new Error('Held'), { status: 409, code: 'UPLOAD_ELSEWHERE' }))
        .retryable
    ).toBe(true)
  })
  it('says the server could not be reached when nothing answered', () => {
    expect(plainFailure(new TypeError('Failed to fetch'))).toEqual({
      message: 'The server could not be reached.',
      retryable: true,
      closed: false
    })
  })
  it('never shows an empty message', () => {
    expect(plainFailure(refusal(500, {}, '')).message).toBe(
      'The server did not accept the recording.'
    )
  })
  it('marks uploads the server no longer holds as closed', () => {
    expect(
      plainFailure(refusal(404, { message: 'Upload not found', code: 'UPLOAD_NOT_FOUND' })).closed
    ).toBe(true)
    expect(
      plainFailure(refusal(422, { message: 'Not a video', code: 'UPLOAD_NOT_VIDEO' })).closed
    ).toBe(false)
  })
})

describe('stopsRecording', () => {
  it('stops for a refusal, never for an outage', () => {
    expect(stopsRecording(refusal(422, { code: 'UPLOAD_NOT_VIDEO' }))).toBe(true)
    expect(stopsRecording(new TypeError('Failed to fetch'))).toBe(false)
    expect(stopsRecording(refusal(503, {}))).toBe(false)
    expect(
      stopsRecording(Object.assign(new Error('x'), { status: 409, code: 'UPLOAD_ELSEWHERE' }))
    ).toBe(false)
  })
})
