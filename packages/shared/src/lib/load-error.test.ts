import { describe, expect, it } from 'vitest'
import {
  isListTimeout,
  listLoadErrorText,
  loadErrorStatus,
  loadErrorText,
  serverErrorText
} from './load-error'

describe('loadErrorText (#2858)', () => {
  it('reads every error shape', () => {
    expect(loadErrorStatus({ status: 503 })).toBe(503)
    expect(loadErrorStatus({ response: { status: 500 } })).toBe(500)
    expect(loadErrorStatus(new TypeError('Failed to fetch'))).toBeNull()
  })
  it('says what happened in plain words', () => {
    expect(loadErrorText(new TypeError('Failed to fetch'))).toMatch(/reach the server/)
    expect(loadErrorText({ response: { status: 503 } })).toMatch(/unavailable/)
    expect(loadErrorText({ status: 500 }, 'this widget')).toBe(
      'The server hit an error loading this widget.'
    )
    expect(loadErrorText({ status: 404 }, 'this widget')).toBe('This widget no longer exists.')
    expect(loadErrorText(new Error('weird'))).toBe('Couldn’t load this.')
    // A bug in our code is not "can't reach the server", and its text never shows.
    expect(loadErrorText(new TypeError("Cannot read properties of null (reading 'id')"))).toBe(
      'Something went wrong — it’s been reported'
    )
  })
})

describe('serverErrorText', () => {
  it('keeps a real explanation, drops bare status words', () => {
    expect(serverErrorText({ response: { error: 'Sales query is unavailable' } })).toBe(
      'Sales query is unavailable'
    )
    expect(serverErrorText({ response: { data: { error: 'Bad filter' } } })).toBe('Bad filter')
    expect(serverErrorText({ response: { error: 'Service Unavailable' } })).toBeNull()
    expect(serverErrorText(new TypeError('Failed to fetch'))).toBeNull()
  })
})

describe('loadErrorText timeouts (#2857)', () => {
  it('says a request that never answered took too long', () => {
    expect(loadErrorText(new Error('timeout of 30000ms exceeded'))).toMatch(/too long/)
    expect(loadErrorText(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toMatch(
      /too long/
    )
  })
})

describe('list load errors', () => {
  const timeout = {
    status: 503,
    response: {
      statusCode: 503,
      error: 'Service Unavailable',
      message:
        'This search took too long to finish. Try again, or search for something more specific.'
    }
  }
  const busy = {
    status: 503,
    response: {
      code: 'SERVER_BUSY',
      message: 'The server is busy right now. Please try again in a few seconds.'
    }
  }
  it('tells a list timeout apart (code or, with no code on 5xx, its sentence)', () => {
    expect(isListTimeout(timeout)).toBe(true)
    expect(isListTimeout({ status: 503, response: { code: 'LIST_TIMEOUT' } })).toBe(true)
    expect(isListTimeout({ response: { status: 503, data: timeout.response } })).toBe(true)
    expect(isListTimeout(busy)).toBe(false)
    expect(isListTimeout({ status: 500, response: timeout.response })).toBe(false)
  })
  it("shows a 503's own words, else the plain sentence", () => {
    expect(listLoadErrorText(timeout)).toBe(timeout.response.message)
    expect(listLoadErrorText(busy)).toBe(busy.response.message)
    expect(listLoadErrorText({ status: 503 })).toMatch(/busy/)
    expect(listLoadErrorText({ status: 500 })).toBe('The server hit an error loading this list.')
  })
})
