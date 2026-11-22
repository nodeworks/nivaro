import { describe, expect, it } from 'vitest'
import { hubError } from './hub-api'

const refused = (field: string) => ({
  isAxiosError: true,
  message: 'Request failed with status code 409',
  response: { status: 409, data: { code: 'STACK_RUNNING', field, error: 'x' } }
})

describe('hubError STACK_RUNNING', () => {
  it('names the refused field, with the caller’s own label first', () => {
    expect(hubError(refused('key'), 'Could not save').hint).toContain('the key')
    expect(hubError(refused('key'), 'Could not save', { key: 'the app key' }).hint).toContain(
      'the app key'
    )
    expect(hubError(refused('placement_id'), 'Could not save').hint).toContain('the placement')
  })
})

describe('hubError names who holds the environment (X-6b)', () => {
  const held = (code: string) => ({
    isAxiosError: true,
    message: 'Request failed with status code 409',
    response: { status: 409, data: { code, error: 'server words' } }
  })
  it.each([
    ['CREATION_RUNNING', 'A creation step is running on this environment'],
    ['PROMOTION_RUNNING', 'A promotion is already running here'],
    ['STACK_BUSY', 'A stack restart or removal is running on this environment']
  ])('%s', (code, title) => {
    expect(hubError(held(code), 'Could not delete').title).toBe(title)
  })
})

describe('hubError: hub token input rules (X-7)', () => {
  const refused = (code: string) => ({
    isAxiosError: true,
    message: 'Request failed with status code 400',
    response: { status: 400, data: { code, field: 'hub_token', error: 'server words' } }
  })
  it.each([
    ['HUB_TOKEN_MASK', 'That is the hidden token, not a token'],
    ['HUB_TOKEN_TOO_SHORT', 'The hub token is too short']
  ])('%s', (code, title) => {
    expect(hubError(refused(code), 'Could not save').title).toBe(title)
  })
})
