import { describe, expect, it } from 'vitest'
import { cardBrandFrom, clipsInFlight, helpVideoError, parseRoleIdList } from './api'
import type { ClipDto } from './types'

describe('parseRoleIdList', () => {
  it('reads the stored JSON string', () => expect(parseRoleIdList('["A","B"]')).toEqual(['A', 'B']))
  it('accepts an array and drops non-strings and blanks', () =>
    expect(parseRoleIdList(['A', 3, '', null, 'B'])).toEqual(['A', 'B']))
  it('reads nothing from null, blanks and broken JSON', () => {
    expect(parseRoleIdList(null)).toEqual([])
    expect(parseRoleIdList('  ')).toEqual([])
    expect(parseRoleIdList('[oops')).toEqual([])
    expect(parseRoleIdList('{"a":1}')).toEqual([])
  })
})

describe('helpVideoError', () => {
  it('reads the status, code and current_hash the SDK attaches', () => {
    const err = Object.assign(new Error('Someone else saved'), {
      status: 409,
      response: { code: 'HELP_VIDEO_EDITS_CONFLICT', current_hash: 'abc' }
    })
    expect(helpVideoError(err)).toEqual({
      status: 409,
      code: 'HELP_VIDEO_EDITS_CONFLICT',
      current_hash: 'abc'
    })
  })
  it('is null for anything that is not a request failure', () => {
    expect(helpVideoError(new Error('x'))).toBeNull()
    expect(helpVideoError(null)).toBeNull()
  })
})

describe('cardBrandFrom', () => {
  it('draws the cards’ own logo, not the instance logo', () => {
    const b = cardBrandFrom(
      { name: 'Acme', color: '#00ceff', logo_url: '/api/files/I', card_logo_url: '/api/files/C' },
      'https://x'
    )
    expect(b.logo).toBe('https://x/api/files/C')
  })
  it('falls back to the instance logo on an older server', () => {
    const b = cardBrandFrom({ name: 'Acme', color: null, logo_url: '/api/files/I' }, '')
    expect(b.logo).toBe('/api/files/I')
  })
})

describe('clipsInFlight', () => {
  const clip = (status: ClipDto['status']) => ({ status }) as ClipDto
  it('keeps polling while a clip is queued or being made', () => {
    expect(clipsInFlight([clip('ready'), clip('queued')])).toBe(true)
    expect(clipsInFlight([clip('rendering')])).toBe(true)
    expect(clipsInFlight([clip('ready'), clip('failed')])).toBe(false)
  })
  it('is false without a list', () => {
    expect(clipsInFlight(undefined)).toBe(false)
    expect(clipsInFlight({} as unknown as ClipDto[])).toBe(false)
  })
})
